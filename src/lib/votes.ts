import { getRedis } from './redis';
import { buildRanking } from './ranking';
import { config } from './config';
import { hasDragonfly } from './features';
import { castVotesMemory, readWorldMemory } from './memory-store';
import type { RankingEntry } from './types';
import type { RedisClientType } from 'redis';

/**
 * Servicio de votos: todo lo que toca DragonFly vive aquí.
 *
 * Claves:
 *   votes:ranking      ZSET  (member = code, score = votos)
 *   votes:total        INT   contador global de votos válidos
 *   votes:blocked      INT   clicks bloqueados por rate limit
 *   cps:{epochSecond}  INT    votos en ese segundo (clicks/segundo)
 *   rl:{ip}:{window}   INT   ventana de rate limit por IP
 *
 * Optimización clave: el voto se procesa con un ÚNICO script Lua atómico
 * (rate limit + reparto + escritura). Un solo viaje de red por lote y
 * cero condiciones de carrera. Es lo que nos permite tragar avalanchas.
 */

const RANKING_KEY = 'votes:ranking';
const TOTAL_KEY = 'votes:total';
const BLOCKED_KEY = 'votes:blocked';
const CPS_PREFIX = 'cps';

/** Resultado de procesar un lote de votos. */
export interface VoteOutcome {
  /** false si no había sesión de captcha válida (nada se procesó). */
  sessionValid: boolean;
  /** Votos aceptados del lote. */
  accepted: number;
  /** Votos bloqueados por rate limit. */
  blocked: number;
  /** Huecos restantes en la ventana. */
  remaining: number;
  /** Nuevos totales por país afectado. */
  counts: Record<string, number>;
  /** Ms hasta poder reintentar (si hubo bloqueo). */
  retryAfter: number;
}

/**
 * Script Lua atómico. Hace, en el servidor y de una sola vez:
 *   0. Comprueba que exista la SESIÓN de captcha (si no, corta con -1).
 *   1. INCRBY de la ventana de rate limit + EXPIRE.
 *   2. Calcula cuántos votos caben (allowed) y cuántos se bloquean.
 *   3. ZINCRBY por país (repartiendo el cupo permitido en orden).
 *   4. INCRBY de total y de clicks/segundo (+EXPIRE), y de bloqueados.
 *   5. Devuelve [accepted, blocked, remaining, code, score, code, score...]
 *      o [-1] si no hay sesión de captcha válida.
 *
 * KEYS: rl, ranking, total, cps, blocked, session
 * ARGV: cost, maxWin, winExpire, cpsExpire, sessionTtl, requireSession,
 *       [code, count]...
 */
const VOTE_SCRIPT = `
-- 0. Si el captcha está activo (requireSession=1) exigimos una sesión
--    válida; si no existe, cortamos con -1. Con captcha desactivado se
--    salta esta comprobación por completo.
if tonumber(ARGV[6]) == 1 then
  if redis.call('EXISTS', KEYS[6]) == 0 then
    return {-1}
  end
  redis.call('EXPIRE', KEYS[6], tonumber(ARGV[5]))
end

local cost = tonumber(ARGV[1])
local maxWin = tonumber(ARGV[2])
local winExp = tonumber(ARGV[3])
local cpsExp = tonumber(ARGV[4])

local countAfter = redis.call('INCRBY', KEYS[1], cost)
redis.call('EXPIRE', KEYS[1], winExp)

local freeBefore = maxWin - (countAfter - cost)
if freeBefore < 0 then freeBefore = 0 end
local allowed = cost
if allowed > freeBefore then allowed = freeBefore end
local blocked = cost - allowed

local budget = allowed
local accepted = 0
local out = {}
local i = 7
while i < #ARGV do
  local code = ARGV[i]
  local cnt = tonumber(ARGV[i + 1])
  local apply = cnt
  if apply > budget then apply = budget end
  if apply > 0 then
    local newscore = redis.call('ZINCRBY', KEYS[2], apply, code)
    budget = budget - apply
    accepted = accepted + apply
    out[#out + 1] = code
    out[#out + 1] = newscore
  end
  i = i + 2
end

if accepted > 0 then
  redis.call('INCRBY', KEYS[3], accepted)
  redis.call('INCRBY', KEYS[4], accepted)
  redis.call('EXPIRE', KEYS[4], cpsExp)
end
if blocked > 0 then
  redis.call('INCRBY', KEYS[5], blocked)
end

local remaining = maxWin - countAfter
if remaining < 0 then remaining = 0 end
local res = {accepted, blocked, remaining}
for _, v in ipairs(out) do res[#res + 1] = v end
return res
`;

// SHA del script cacheado tras el primer SCRIPT LOAD (usamos EVALSHA para
// no reenviar el cuerpo del script en cada petición).
let scriptSha: string | null = null;

async function runVoteScript(
  redis: RedisClientType,
  keys: string[],
  args: string[],
): Promise<(string | number)[]> {
  if (!scriptSha) {
    scriptSha = await redis.scriptLoad(VOTE_SCRIPT);
  }
  try {
    return (await redis.evalSha(scriptSha, {
      keys,
      arguments: args,
    })) as (string | number)[];
  } catch (err) {
    // Si DragonFly reinició y perdió el script, recargamos y reintentamos.
    if (String(err).includes('NOSCRIPT')) {
      scriptSha = await redis.scriptLoad(VOTE_SCRIPT);
      return (await redis.evalSha(scriptSha, {
        keys,
        arguments: args,
      })) as (string | number)[];
    }
    throw err;
  }
}

/** Sesión de captcha a verificar de forma atómica (si el captcha está on). */
export interface VoteSession {
  /** Clave de DragonFly de la sesión. */
  key: string;
  /** TTL a renovar en cada voto (segundos). */
  ttl: number;
}

/**
 * Procesa un lote de votos de forma atómica.
 * @param ip      IP del cliente (para el rate limit).
 * @param votes   Mapa code -> cantidad solicitada.
 * @param cost    Total solicitado (suma de cantidades, ya recortado).
 * @param session Sesión de captcha a exigir (omitir si el captcha está off).
 *
 * Sin DragonFly configurado, cae al store en memoria (modo demo).
 */
export async function castVotes(
  ip: string,
  votes: Map<string, number>,
  cost: number,
  session?: VoteSession,
): Promise<VoteOutcome> {
  if (!hasDragonfly) {
    return castVotesMemory(ip, votes, cost);
  }

  const redis = await getRedis();
  const { maxPerWindow, windowSeconds } = config.rateLimit;

  const now = Date.now();
  const window = Math.floor(now / (windowSeconds * 1000));
  const second = Math.floor(now / 1000);

  const keys = [
    `rl:${ip}:${window}`,
    RANKING_KEY,
    TOTAL_KEY,
    `${CPS_PREFIX}:${second}`,
    BLOCKED_KEY,
    // Con captcha off, KEYS[6] no se toca; un placeholder es suficiente.
    session?.key ?? 'session:__none__',
  ];

  const args = [
    String(cost),
    String(maxPerWindow),
    String(windowSeconds + 1),
    '5', // expiración de la ventana de clicks/segundo
    String(session?.ttl ?? 1),
    session ? '1' : '0', // requireSession
  ];
  for (const [code, count] of votes) {
    args.push(code, String(count));
  }

  const reply = await runVoteScript(redis, keys, args);

  // El script devuelve [-1] si la sesión de captcha no es válida.
  if (Number(reply[0]) === -1) {
    return {
      sessionValid: false,
      accepted: 0,
      blocked: 0,
      remaining: 0,
      counts: {},
      retryAfter: 0,
    };
  }

  const accepted = Number(reply[0]);
  const blocked = Number(reply[1]);
  const remaining = Number(reply[2]);
  const counts: Record<string, number> = {};
  for (let i = 3; i < reply.length; i += 2) {
    counts[String(reply[i])] = Number(reply[i + 1]);
  }

  const retryAfter =
    blocked > 0 ? (window + 1) * windowSeconds * 1000 - now : 0;

  return { sessionValid: true, accepted, blocked, remaining, counts, retryAfter };
}

/**
 * Lee todo el estado del mundo en UN SOLO pipeline (una ida y vuelta):
 * ranking, total, bloqueados y clicks/segundo. Lo usa el poller una vez
 * por tick, así que su coste es constante e independiente del tráfico.
 */
export async function readWorld(): Promise<{
  ranking: RankingEntry[];
  totalVotes: number;
  blockedClicks: number;
  clicksPerSecond: number;
}> {
  if (!hasDragonfly) {
    return readWorldMemory();
  }

  const redis = await getRedis();
  const previousSecond = Math.floor(Date.now() / 1000) - 1;

  const multi = redis.multi();
  multi.zRangeWithScores(RANKING_KEY, 0, -1, { REV: true });
  multi.get(TOTAL_KEY);
  multi.get(BLOCKED_KEY);
  multi.get(`${CPS_PREFIX}:${previousSecond}`);
  const [raw, total, blocked, cps] = (await multi.exec()) as [
    { value: string; score: number }[],
    string | null,
    string | null,
    string | null,
  ];

  const scores = new Map<string, number>();
  for (const { value, score } of raw) {
    scores.set(value, score);
  }

  return {
    ranking: buildRanking(scores),
    totalVotes: Number(total ?? 0),
    blockedClicks: Number(blocked ?? 0),
    clicksPerSecond: Number(cps ?? 0),
  };
}

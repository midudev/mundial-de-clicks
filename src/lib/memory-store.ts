import { config } from './config';
import { buildRanking } from './ranking';
import { incrementDailyVotesMemory, readDailyVotes } from './daily-vote-limit';
import type { RankingEntry } from './types';
import type { VoteOutcome } from './votes';

/**
 * Store de votos EN MEMORIA. Es el fallback cuando no hay DragonFly
 * configurado: la web funciona igual (se vota, el ranking se mueve), pero
 * los datos viven en el proceso y se pierden al reiniciar. Sirve para que
 * la app arranque "sin nada configurado" y para desarrollo.
 *
 * Replica la misma lógica que el script Lua de `votes.ts`:
 *   rate limit por IP (ventana fija) + reparto del cupo + contadores.
 * No hay captcha en este modo (el captcha requiere DragonFly).
 */

const scores = new Map<string, number>();
let totalVotes = 0;
let blockedClicks = 0;

/** Token bucket por IP: ip -> { tokens disponibles, última actualización }. */
const rateBuckets = new Map<string, { tokens: number; updated: number }>();
/** Clicks por segundo: epochSecond -> votos. Se suman los 60 últimos. */
const perSecond = new Map<number, number>();

/** Segundos de la ventana deslizante para calcular los clicks/minuto. */
const MINUTE_WINDOW = 60;

/** Evita que los mapas efímeros crezcan sin límite bajo carga. */
function prune(now: number, currentSecond: number): void {
  if (rateBuckets.size > 50_000) {
    for (const [ip, entry] of rateBuckets) {
      if (now - entry.updated > 120_000) rateBuckets.delete(ip);
    }
  }
  // Conservamos la ventana completa de 60s que necesita el clicks/minuto.
  for (const second of perSecond.keys()) {
    if (second < currentSecond - MINUTE_WINDOW) perSecond.delete(second);
  }
}

/** Procesa un lote de votos en memoria (equivalente al Lua de DragonFly). */
export async function castVotesMemory(
  ip: string,
  votes: Map<string, number>,
  cost: number,
): Promise<VoteOutcome> {
  const { maxPerWindow, windowSeconds } = config.rateLimit;
  const now = Date.now();
  const second = Math.floor(now / 1000);

  // --- Rate limit por IP (token bucket) ---
  const refillWindowMs = windowSeconds * 1000;
  const entry = rateBuckets.get(ip);
  let tokens = entry?.tokens ?? maxPerWindow;
  const updated = entry?.updated ?? now;
  const elapsed = Math.max(0, now - updated);
  tokens = Math.min(maxPerWindow, tokens + (elapsed * maxPerWindow) / refillWindowMs);
  const dailyVotes = await readDailyVotes(ip);
  const dailyRemaining = Math.max(0, config.dailyLimit.maxVotesPerIp - dailyVotes);
  const allowed = Math.min(cost, Math.floor(tokens), dailyRemaining);
  const blocked = cost - allowed;
  tokens -= allowed;
  rateBuckets.set(ip, { tokens, updated: now });

  // --- Reparto del cupo permitido entre los países del lote ---
  let budget = allowed;
  let accepted = 0;
  const counts: Record<string, number> = {};
  for (const [code, requested] of votes) {
    const apply = Math.min(requested, budget);
    if (apply > 0) {
      const newScore = (scores.get(code) ?? 0) + apply;
      scores.set(code, newScore);
      counts[code] = newScore;
      budget -= apply;
      accepted += apply;
    }
  }

  if (accepted > 0) {
    totalVotes += accepted;
    perSecond.set(second, (perSecond.get(second) ?? 0) + accepted);
    incrementDailyVotesMemory(ip, accepted);
  }
  if (blocked > 0) blockedClicks += blocked;

  prune(now, second);

  const remaining = Math.max(0, Math.floor(tokens));
  const retryAfter =
    blocked > 0 && dailyRemaining <= 0
      ? 60_000
      : blocked > 0 && tokens < 1
      ? Math.ceil(((1 - tokens) * refillWindowMs) / maxPerWindow)
      : 0;

  // sessionValid siempre true: en modo memoria no hay captcha.
  return { sessionValid: true, accepted, blocked, remaining, counts, retryAfter };
}

/** Lee el estado del mundo desde memoria (equivalente a readWorld). */
export function readWorldMemory(): {
  ranking: RankingEntry[];
  totalVotes: number;
  blockedClicks: number;
  clicksPerMinute: number;
} {
  // Ventana deslizante: sumamos los 60 segundos previos (excluyendo el
  // segundo en curso, que aún se está llenando).
  const nowSecond = Math.floor(Date.now() / 1000);
  let clicksPerMinute = 0;
  for (let i = 1; i <= MINUTE_WINDOW; i++) {
    clicksPerMinute += perSecond.get(nowSecond - i) ?? 0;
  }
  return {
    ranking: buildRanking(new Map(scores)),
    totalVotes,
    blockedClicks,
    clicksPerMinute,
  };
}

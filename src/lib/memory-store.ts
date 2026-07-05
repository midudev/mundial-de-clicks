import { config } from './config';
import { buildRanking } from './ranking';
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

/** Rate limit por IP: ip -> { ventana, votos en esa ventana }. */
const rateWindows = new Map<string, { window: number; count: number }>();
/** Clicks por segundo: epochSecond -> votos. */
const perSecond = new Map<number, number>();

/** Evita que los mapas efímeros crezcan sin límite bajo carga. */
function prune(currentWindow: number, currentSecond: number): void {
  if (rateWindows.size > 50_000) {
    for (const [ip, entry] of rateWindows) {
      if (entry.window < currentWindow) rateWindows.delete(ip);
    }
  }
  for (const second of perSecond.keys()) {
    if (second < currentSecond - 5) perSecond.delete(second);
  }
}

/** Procesa un lote de votos en memoria (equivalente al Lua de DragonFly). */
export function castVotesMemory(
  ip: string,
  votes: Map<string, number>,
  cost: number,
): VoteOutcome {
  const { maxPerWindow, windowSeconds } = config.rateLimit;
  const now = Date.now();
  const window = Math.floor(now / (windowSeconds * 1000));
  const second = Math.floor(now / 1000);

  // --- Rate limit por IP (ventana fija) ---
  const entry = rateWindows.get(ip);
  const before = entry && entry.window === window ? entry.count : 0;
  const countAfter = before + cost;
  rateWindows.set(ip, { window, count: countAfter });

  const freeBefore = Math.max(0, maxPerWindow - before);
  const allowed = Math.min(cost, freeBefore);
  const blocked = cost - allowed;

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
  }
  if (blocked > 0) blockedClicks += blocked;

  prune(window, second);

  const remaining = Math.max(0, maxPerWindow - countAfter);
  const retryAfter =
    blocked > 0 ? (window + 1) * windowSeconds * 1000 - now : 0;

  // sessionValid siempre true: en modo memoria no hay captcha.
  return { sessionValid: true, accepted, blocked, remaining, counts, retryAfter };
}

/** Lee el estado del mundo desde memoria (equivalente a readWorld). */
export function readWorldMemory(): {
  ranking: RankingEntry[];
  totalVotes: number;
  blockedClicks: number;
  clicksPerSecond: number;
} {
  const previousSecond = Math.floor(Date.now() / 1000) - 1;
  return {
    ranking: buildRanking(new Map(scores)),
    totalVotes,
    blockedClicks,
    clicksPerSecond: perSecond.get(previousSecond) ?? 0,
  };
}

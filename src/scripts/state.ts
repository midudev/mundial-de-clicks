import { COUNTRIES } from '../lib/countries';
import { buildRanking } from '../lib/ranking';
import type { RankingEntry, WorldSnapshot } from '../lib/types';

/**
 * Estado optimista del cliente.
 *
 * Idea clave para que se sienta EN TIEMPO REAL: los contadores solo
 * SUBEN. Al hacer click incrementamos al instante; cuando llega el
 * snapshot del servidor por SSE, reconciliamos con `Math.max`. Como los
 * votos nunca bajan, el valor mostrado nunca "retrocede" y no hay el
 * parpadeo que se veía al sincronizar.
 */

const counts = new Map<string, number>(COUNTRIES.map((c) => [c.code, 0]));

const stats = {
  total: 0,
  clicksPerSecond: 0,
  blocked: 0,
};

/** Incremento optimista inmediato al hacer click. */
export function bump(code: string, amount = 1): void {
  counts.set(code, (counts.get(code) ?? 0) + amount);
  stats.total += amount;
}

/**
 * Reconciliación monotónica con el estado autoritativo del servidor.
 * Solo sube: si el server va por detrás, mantenemos nuestro valor.
 */
export function reconcile(snapshot: WorldSnapshot): void {
  for (const entry of snapshot.ranking) {
    const local = counts.get(entry.code) ?? 0;
    counts.set(entry.code, Math.max(local, entry.votes));
  }
  stats.total = Math.max(stats.total, snapshot.totalVotes);
  // cps y blocked son puramente informativos: los tomamos del servidor.
  stats.clicksPerSecond = snapshot.clicksPerSecond;
  stats.blocked = snapshot.blockedClicks;
}

/** Votos actuales (optimistas) de un país. */
export function getVotes(code: string): number {
  return counts.get(code) ?? 0;
}

/** Ranking calculado en cliente para reordenar al instante. */
export function getRanking(): RankingEntry[] {
  return buildRanking(counts);
}

/** Estadísticas globales actuales. */
export function getStats(): Readonly<typeof stats> {
  return stats;
}

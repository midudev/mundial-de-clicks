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
  clicksPerMinute: 0,
  blocked: 0,
};

/** Incremento optimista inmediato al hacer click. */
export function bump(code: string, amount = 1): void {
  counts.set(code, (counts.get(code) ?? 0) + amount);
  stats.total += amount;
}

/**
 * Revierte votos optimistas que el servidor NO llegó a contar (bloqueados
 * por rate limit o perdidos por un error de red). Sin esto, el estado local
 * queda inflado para siempre: como `reconcile` solo sube (Math.max), el
 * servidor nunca "alcanza" ese valor fantasma y el contador se descuadra.
 * Nunca baja de 0; si nos pasáramos de frenada, el siguiente snapshot lo
 * recupera vía Math.max.
 */
export function revert(code: string, amount = 1): void {
  counts.set(code, Math.max(0, (counts.get(code) ?? 0) - amount));
  stats.total = Math.max(0, stats.total - amount);
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
  // cpm y blocked son puramente informativos: los tomamos del servidor.
  stats.clicksPerMinute = snapshot.clicksPerMinute;
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

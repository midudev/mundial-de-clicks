import { COUNTRIES } from './countries';
import type { RankingEntry } from './types';

/**
 * Construye el ranking ordenado a partir de un mapa code -> votos.
 *
 * Se comparte entre servidor (lee de DragonFly) y cliente (estado
 * optimista), así el orden y las posiciones se calculan igual en ambos
 * lados y no hay saltos raros al sincronizar.
 *
 * Incluye países con 0 votos para mostrarlos desde el inicio. Ordena por
 * votos desc y, a igualdad, por nombre (estable).
 */
export function buildRanking(
  votesByCode: ReadonlyMap<string, number>,
): RankingEntry[] {
  return COUNTRIES.map((country) => ({
    ...country,
    votes: votesByCode.get(country.code) ?? 0,
  }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
    .map((entry, index) => ({ ...entry, position: index + 1 }));
}

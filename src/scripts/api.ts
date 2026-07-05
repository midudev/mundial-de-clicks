import type { VoteResponse } from '../lib/types';

/**
 * Envía un LOTE de votos al servidor.
 * `votes` es un mapa code -> cantidad acumulada desde el último envío.
 */
export async function sendVotes(
  votes: Map<string, number>,
): Promise<VoteResponse> {
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ votes: Object.fromEntries(votes) }),
      // No necesitamos la respuesta para pintar (lo hace la UI optimista),
      // así que mantenemos la petición lo más ligera posible.
      keepalive: true,
    });
    return (await res.json()) as VoteResponse;
  } catch {
    return { ok: false, reason: 'error' };
  }
}

import type { VoteResponse } from '../lib/types';

/**
 * Envía un LOTE de votos al servidor.
 * `votes` es un mapa code -> cantidad acumulada desde el último envío.
 * `captchaToken`, si se pasa, es un token de captcha de UN SOLO USO que el
 * servidor valida (y consume) para abrir la ventana de voto.
 */
export async function sendVotes(
  votes: Map<string, number>,
  captchaToken?: string,
): Promise<VoteResponse> {
  try {
    const payload: { votes: Record<string, number>; captchaToken?: string } = {
      votes: Object.fromEntries(votes),
    };
    if (captchaToken) payload.captchaToken = captchaToken;

    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // No necesitamos la respuesta para pintar (lo hace la UI optimista),
      // así que mantenemos la petición lo más ligera posible.
      keepalive: true,
    });
    return (await res.json()) as VoteResponse;
  } catch {
    return { ok: false, reason: 'error' };
  }
}

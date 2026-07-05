import type { APIRoute } from 'astro';
import { getWorldState } from '../../lib/world-state';

export const prerender = false;

/**
 * GET /api/ranking
 * Devuelve el snapshot actual (ranking + contadores + eventos).
 *
 * Se sirve desde el estado en memoria, así que es muy barato. Útil para
 * la carga inicial de la página y como fallback si SSE no está disponible.
 */
export const GET: APIRoute = async () => {
  const snapshot = getWorldState().getSnapshot();
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};

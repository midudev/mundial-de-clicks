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
  const world = getWorldState();
  // Fuerza una lectura fresca: si no hay espectadores SSE, el poller está
  // dormido y el snapshot podría estar viejo. `refresh` respeta su propio
  // timeout y guard, así que es barato y seguro.
  await world.refresh();
  const snapshot = world.getSnapshot();
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};

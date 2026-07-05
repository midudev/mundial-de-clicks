import type { APIRoute } from 'astro';
import { featureStatus } from '../../lib/features';

export const prerender = false;

/**
 * GET /api/status
 * Qué integraciones están configuradas (DragonFly, captcha, Umami). El
 * cliente lo usa para pintar los avisos visuales: así ves de un vistazo qué
 * está conectado y qué falta por configurar.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify(featureStatus()), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

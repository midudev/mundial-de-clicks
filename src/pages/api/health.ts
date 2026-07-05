import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * GET /api/health
 * Health check para Coolify/Traefik. Devuelve 200 sin tocar dependencias
 * externas (DragonFly, etc.): sólo confirma que el servidor Node está vivo
 * y respondiendo. Coolify enruta tráfico únicamente si esto pasa.
 */
export const GET: APIRoute = () => {
  return new Response('OK', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
};

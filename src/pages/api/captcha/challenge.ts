import type { APIRoute } from 'astro';
import { proxyToCap } from '../../../lib/captcha';
import { hasCaptcha } from '../../../lib/features';

export const prerender = false;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * POST /api/captcha/challenge
 * El widget pide aquí un reto. Hacemos de proxy al servidor Cap standalone.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!hasCaptcha) {
    return json({ error: 'captcha_disabled' }, 404);
  }

  // El widget puede no enviar cuerpo; da igual, Cap solo mira la ruta.
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* sin cuerpo */
  }

  try {
    const { status, data } = await proxyToCap('challenge', body);
    return json(data, status);
  } catch {
    return json({ error: 'captcha_unreachable' }, 502);
  }
};

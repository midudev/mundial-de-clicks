import type { APIRoute } from 'astro';
import { proxyToCap } from '../../../lib/captcha';
import { hasCaptcha } from '../../../lib/features';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * POST /api/captcha/redeem
 * El widget canjea aquí la solución del reto. Hacemos de PROXY al servidor
 * Cap standalone y devolvemos su respuesta TAL CUAL: si el PoW es válido,
 * Cap responde con un TOKEN de verificación de un solo uso que el widget nos
 * entrega y el cliente manda luego a /api/vote. Aquí NO se crea sesión: la
 * sesión de voto se abre en /api/vote al validar (y consumir) ese token.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!hasCaptcha) {
    return json({ success: false, error: 'captcha_disabled' }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: 'invalid_body' }, 400);
  }

  try {
    const { status, data } = await proxyToCap('redeem', body);
    return json(data, status);
  } catch {
    return json({ success: false, error: 'captcha_unreachable' }, 502);
  }
};

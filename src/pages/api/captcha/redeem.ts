import type { APIRoute } from 'astro';
import { proxyToCap, createSession, sessionCookie } from '../../../lib/captcha';
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
 * El widget canjea aquí la solución del reto. Hacemos de proxy al servidor
 * Cap standalone; si Cap valida el PoW, creamos una SESIÓN y la devolvemos
 * como cookie (es lo que luego exige la API de votos).
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

  let status: number;
  let data: unknown;
  try {
    ({ status, data } = await proxyToCap('redeem', body));
  } catch {
    return json({ success: false, error: 'captcha_unreachable' }, 502);
  }

  // Cap no validó el PoW → devolvemos su respuesta tal cual (sin sesión).
  const ok =
    status === 200 && !!data && (data as { success?: boolean }).success === true;
  if (!ok) {
    return json(data ?? { success: false }, status || 400);
  }

  // Captcha superado → sesión + cookie.
  // Cookie SIN `Secure`: la app se sirve por http:// (sslip.io sin TLS) y los
  // navegadores descartan cookies Secure sobre HTTP. Si algún día se sirve por
  // HTTPS, se puede volver a poner `import.meta.env.PROD`.
  const id = await createSession();
  const cookie = sessionCookie(id, false);

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': cookie,
    },
  });
};

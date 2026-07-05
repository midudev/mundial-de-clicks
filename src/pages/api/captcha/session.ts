import type { APIRoute } from 'astro';
import { readCookie, isSessionValid, SESSION_COOKIE } from '../../../lib/captcha';
import { hasCaptcha } from '../../../lib/features';

export const prerender = false;

/**
 * GET /api/captcha/session
 * Le dice al cliente si el captcha está activo (`required`) y si ya tiene
 * una sesión válida (`valid`). Con `required=false`, el cliente ni siquiera
 * carga el widget/WASM: se puede votar directamente.
 */
export const GET: APIRoute = async ({ request }) => {
  const required = hasCaptcha;
  const id = readCookie(request, SESSION_COOKIE) ?? '';
  const valid = required ? await isSessionValid(id) : true;

  return new Response(JSON.stringify({ required, valid }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

import { randomUUID } from 'node:crypto';
import { getRedis } from './redis';
import { config } from './config';

/**
 * Captcha con Cap (proof-of-work) usando un servidor Cap STANDALONE
 * desplegado aparte (p.ej. un recurso Cap en Coolify).
 *
 * Flujo:
 *   1. El widget pide un reto a /api/captcha/challenge y lo canjea en
 *      /api/captcha/redeem. Nuestro backend hace de PROXY al servidor Cap
 *      (`CAP_API_URL/challenge` y `/redeem`): así el widget habla con
 *      nuestro mismo origen (HTTPS, sin CORS ni mixed-content) y el tráfico
 *      hacia Cap sale de servidor a servidor.
 *   2. Si Cap valida el PoW, creamos una SESIÓN (en DragonFly, con TTL) y la
 *      devolvemos como cookie. La API de votos exige esa sesión.
 *
 * Si `CAP_API_URL` no está definida, el captcha queda desactivado (ver
 * `hasCaptcha` en features.ts) y se vota sin él.
 */

export const SESSION_PREFIX = 'cap:sess:';

/** Cookie de sesión y su duración. */
export const SESSION_COOKIE = 'cap_session';
export const SESSION_TTL = 3600; // 1 hora

/** URL base del servidor Cap (sin barra final), o '' si no está configurado. */
export function capApiUrl(): string {
  return config.captcha.apiUrl;
}

/**
 * Reenvía una petición al servidor Cap standalone. `subpath` es 'challenge'
 * o 'redeem'. Devuelve el status y el cuerpo (JSON) tal cual, para que el
 * endpoint los relaye al widget sin transformarlos.
 */
export async function proxyToCap(
  subpath: 'challenge' | 'redeem',
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const base = capApiUrl();
  const res = await fetch(`${base}/${subpath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* Cap siempre responde JSON; si no, dejamos data en null. */
  }
  return { status: res.status, data };
}

/** Crea una sesión verificada en DragonFly y devuelve su id. */
export async function createSession(): Promise<string> {
  const redis = await getRedis();
  const id = randomUUID();
  await redis.set(SESSION_PREFIX + id, '1', { EX: SESSION_TTL });
  return id;
}

/** Clave de DragonFly de una sesión (para el script de votos). */
export function sessionKey(id: string): string {
  return SESSION_PREFIX + id;
}

/** Comprueba si una sesión sigue viva. */
export async function isSessionValid(id: string): Promise<boolean> {
  if (!id) return false;
  const redis = await getRedis();
  return (await redis.exists(SESSION_PREFIX + id)) === 1;
}

/** Lee una cookie del header `cookie` de una petición. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Construye el Set-Cookie de la sesión de captcha. */
export function sessionCookie(id: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

import { randomUUID } from 'node:crypto';
import { getRedis, withTimeout } from './redis';
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
 *      hacia Cap sale de servidor a servidor. El canje devuelve un TOKEN de
 *      verificación de Cap (formato `id:vertoken`).
 *   2. El cliente manda ese token a /api/vote. El endpoint lo VALIDA contra
 *      Cap (`CAP_API_URL/validate`), que lo CONSUME (un solo uso): un token
 *      no se puede reutilizar ni compartir. Si es válido, abrimos una SESIÓN
 *      corta y NO renovable (en DragonFly, con TTL) y la devolvemos como
 *      cookie. Dentro de esa ventana se vota sin re-resolver; al caducar, el
 *      cliente resuelve otro PoW invisible y manda un token nuevo.
 *
 * Por qué un token de un solo uso y NO una sesión larga: una sesión-cookie
 * reutilizable es un "bearer token" que un bot resuelve UNA vez y luego
 * comparte con toda la botnet (el servidor solo miraba que existiera). Con
 * validación de token de un solo uso, cada ventana de voto cuesta un PoW
 * fresco e intransferible: la botnet muere sin importar cuántas IPs tenga.
 *
 * Si `CAP_API_URL` no está definida, el captcha queda desactivado (ver
 * `hasCaptcha` en features.ts) y se vota sin él.
 */

export const SESSION_PREFIX = 'cap:sess:';

/**
 * Cookie de sesión y su duración. La ventana es CORTA y NO renovable a
 * propósito: acota a segundos el margen en que una cookie robada/compartida
 * serviría, y obliga a resolver un PoW fresco por ventana. El cliente
 * re-verifica de forma invisible cuando caduca.
 */
export const SESSION_COOKIE = 'cap_session';
export const SESSION_TTL = 60; // 1 minuto (no se renueva)

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
  subpath: 'challenge' | 'redeem' | 'validate',
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const base = capApiUrl();
  // Timeout DURO: si el servidor Cap se cuelga, no dejamos la petición (ni el
  // socket del cliente) colgada indefinidamente. `AbortSignal.timeout` aborta
  // el fetch y el endpoint que nos llama lo traduce a un 502 controlado.
  const res = await fetch(`${base}/${subpath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(config.captchaHttp.timeoutMs),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* Cap siempre responde JSON; si no, dejamos data en null. */
  }
  return { status: res.status, data };
}

/**
 * Valida contra Cap un token de verificación (el que devuelve el canje).
 *
 * IMPORTANTE: es de UN SOLO USO. La validación en el servidor Cap CONSUME el
 * token (lo borra), así que no se puede reutilizar ni compartir entre bots.
 * Este es el pilar del anti-bot: cada ventana de voto exige un token fresco.
 *
 * Fail-closed: ante cualquier error (Cap caído, timeout, respuesta rara)
 * devolvemos `false`. Preferimos rechazar el voto (el cliente reintenta con
 * un token nuevo) a colar votos sin verificar.
 */
export async function validateToken(token: string): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  try {
    const { status, data } = await proxyToCap('validate', { token });
    return status === 200 && (data as { success?: boolean })?.success === true;
  } catch {
    return false;
  }
}

/** Crea una sesión verificada en DragonFly y devuelve su id. */
export async function createSession(): Promise<string> {
  const redis = await getRedis();
  const id = randomUUID();
  await withTimeout(
    redis.set(SESSION_PREFIX + id, '1', { EX: SESSION_TTL }),
    config.redis.commandTimeoutMs,
    'captcha/createSession',
  );
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
  const exists = await withTimeout(
    redis.exists(SESSION_PREFIX + id),
    config.redis.commandTimeoutMs,
    'captcha/isSessionValid',
  );
  return exists === 1;
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

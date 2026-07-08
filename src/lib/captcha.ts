import { createHash, randomUUID } from 'node:crypto';
import { getRedis, withTimeout } from './redis';
import { config } from './config';
import { getTrustedClientIp } from './rate-limit';

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
 *      devolvemos como cookie. La API de votos exige esa sesión, la ata al
 *      mismo fingerprint y consume una cuota corta de votos.
 *
 * Si `CAP_API_URL` no está definida, el captcha queda desactivado (ver
 * `hasCaptcha` en features.ts) y se vota sin él.
 */

export const SESSION_PREFIX = 'cap:sess:';
export const SESSION_FINGERPRINT_PREFIX = 'cap:sess-fp:';

/**
 * Cookie de sesión y su duración. Ventana CORTA (2 min) que se RENUEVA en
 * cada voto aceptado: quien vota de forma continua no ve el captcha en cada
 * click, pero la sesión caduca por tiempo o al agotar la cuota. Acota mucho el
 * margen en que una cookie robada/compartida serviría.
 */
export const SESSION_COOKIE = 'cap_session';
export const SESSION_TTL = Math.max(30, config.captcha.sessionTtlSeconds);
export const SESSION_VOTE_QUOTA = Math.max(
  1,
  Math.min(config.captcha.votesPerSession, config.captcha.hardVotesPerSession),
);

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
 * Fingerprint estable para atar la sesión al cliente que resolvió el reto.
 * En producción usa solo CF-Connecting-IP; nunca X-Forwarded-For.
 */
export function captchaFingerprint(request: Request): string | null {
  const ip = getTrustedClientIp(request);
  if (!ip) return null;
  const userAgent = request.headers.get('user-agent') ?? '';
  return createHash('sha256').update(`${ip}\n${userAgent}`).digest('hex');
}

/** Crea una sesión verificada en DragonFly y devuelve su id. */
export async function createSession(fingerprint: string): Promise<string> {
  const redis = await getRedis();
  const id = randomUUID();
  const sessionKey = SESSION_PREFIX + id;
  const fingerprintKey = SESSION_FINGERPRINT_PREFIX + id;
  const multi = redis
    .multi()
    .set(sessionKey, String(SESSION_VOTE_QUOTA), { EX: SESSION_TTL })
    .set(fingerprintKey, fingerprint, { EX: SESSION_TTL });
  await withTimeout(
    multi.exec(),
    config.redis.commandTimeoutMs,
    'captcha/createSession',
  );
  return id;
}

/** Clave de DragonFly de una sesión (para el script de votos). */
export function sessionKey(id: string): string {
  return SESSION_PREFIX + id;
}

/** Clave de fingerprint de una sesión (para el script de votos). */
export function sessionFingerprintKey(id: string): string {
  return SESSION_FINGERPRINT_PREFIX + id;
}

/** Comprueba si una sesión sigue viva. */
export async function isSessionValid(
  id: string,
  fingerprint = '',
): Promise<boolean> {
  if (!id || !fingerprint) return false;
  const redis = await getRedis();
  const [remaining, storedFingerprint] = await withTimeout(
    redis.mGet([SESSION_PREFIX + id, SESSION_FINGERPRINT_PREFIX + id]),
    config.redis.commandTimeoutMs,
    'captcha/isSessionValid',
  );
  return (
    storedFingerprint === fingerprint &&
    Number.parseInt(remaining ?? '0', 10) > 0
  );
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

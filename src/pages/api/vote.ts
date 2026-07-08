import type { APIRoute } from 'astro';
import { getClientIp } from '../../lib/rate-limit';
import { castVotes, type VoteOutcome } from '../../lib/votes';
import { isValidCountry, COUNTRIES } from '../../lib/countries';
import { hasCaptcha } from '../../lib/features';
import {
  readCookie,
  sessionKey,
  createSession,
  sessionCookie,
  validateToken,
  SESSION_COOKIE,
} from '../../lib/captcha';
import type { VoteResponse } from '../../lib/types';

export const prerender = false;

/** Máximo de votos que aceptamos en una sola petición (anti-abuso). */
const MAX_BATCH = 100;
/** Máximo de claves distintas que miramos (nunca más que países). */
const MAX_KEYS = COUNTRIES.length;
/** Tamaño máximo del body en bytes (el payload real es diminuto). */
const MAX_BODY_BYTES = 2_048;
/**
 * Tope de longitud del token de captcha. El token de Cap es `id:vertoken`
 * (~40 chars); cualquier cosa más larga es basura y no la reenviamos a Cap.
 */
const MAX_TOKEN_LEN = 128;

/**
 * Serializa la respuesta. `cookie`, si viene, se añade como `Set-Cookie`
 * (para entregar la sesión corta recién creada tras validar el captcha).
 */
function json(body: VoteResponse, status: number, cookie?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Lee el cuerpo como texto con un tope DURO de bytes.
 *
 * Defensa contra DoS de memoria: NO nos fiamos del `Content-Length` (se
 * puede mentir u omitir con `Transfer-Encoding: chunked`). Contamos los
 * bytes según llegan y abortamos el stream en cuanto se pasa, así nunca
 * buffeamos megas en memoria. Devuelve `null` si excede el límite.
 */
async function readBodyLimited(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) {
    const text = await request.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * POST /api/vote
 * Body: { "votes": { "es": 5, "ar": 2 } }
 *
 * Recibe un LOTE de votos (el cliente agrupa los clicks para reducir
 * peticiones). Todo el trabajo pesado —validar rate limit, repartir y
 * escribir— se hace en una única operación atómica en DragonFly.
 */
export const POST: APIRoute = async ({ request }) => {
  // Rechaza bodies desproporcionados sin buffear megas en memoria. El tope
  // se aplica leyendo el stream, no confiando en el Content-Length.
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) {
    return json({ ok: false, reason: 'payload_too_large' }, 413);
  }

  // --- Validación de payload ----------------------------------------
  let rawVotes: Record<string, unknown>;
  let captchaToken: string | undefined;
  try {
    const body = JSON.parse(text) as {
      votes?: Record<string, unknown>;
      captchaToken?: unknown;
    };
    rawVotes = body.votes ?? {};
    if (
      typeof body.captchaToken === 'string' &&
      body.captchaToken.length <= MAX_TOKEN_LEN
    ) {
      captchaToken = body.captchaToken;
    }
  } catch {
    return json({ ok: false, reason: 'invalid_payload' }, 400);
  }

  // Rechazamos payloads absurdamente grandes antes de iterar nada.
  const entries = Object.entries(rawVotes);
  if (entries.length === 0 || entries.length > MAX_KEYS) {
    return json({ ok: false, reason: 'invalid_payload' }, 400);
  }

  // Normaliza: solo códigos válidos y cantidades enteras positivas.
  const votes = new Map<string, number>();
  let total = 0;
  for (const [code, value] of entries) {
    const c = code.toLowerCase();
    if (!isValidCountry(c) || votes.has(c)) continue;
    const count = Math.floor(Number(value));
    if (!Number.isFinite(count) || count <= 0) continue;
    votes.set(c, count);
    total += count;
  }

  if (total === 0) {
    return json({ ok: false, reason: 'invalid_payload' }, 400);
  }

  // Recorta el lote a un máximo razonable.
  total = Math.min(total, MAX_BATCH);

  // --- Captcha + procesamiento atómico ------------------------------
  // Con el captcha activo, cada voto necesita una sesión de captcha viva.
  // La sesión se abre validando un TOKEN de Cap de UN SOLO USO y dura una
  // ventana corta y NO renovable (ver captcha.ts). Estrategia:
  //   1. Si la cookie trae una sesión viva → se vota (ruta caliente: 1 viaje
  //      a DragonFly, sin tocar Cap). El script devuelve -1 si ya expiró.
  //   2. Si no hay sesión viva → exigimos `captchaToken`, lo validamos contra
  //      Cap (que lo consume) y, si es válido, abrimos una sesión nueva y
  //      reintentamos. El primer intento del paso 1 NO gasta rate limit
  //      cuando corta por sesión inválida, así que no hay doble cómputo.
  const ip = getClientIp(request);

  // Cookie de sesión a entregar si abrimos una nueva en esta petición.
  let newCookie: string | undefined;

  try {
    let outcome: VoteOutcome | undefined;

    if (!hasCaptcha) {
      // Captcha desactivado: se vota sin sesión.
      outcome = await castVotes(ip, votes, total);
    } else {
      // 1) Intento con la sesión de la cookie (si la hay).
      const cookieId = readCookie(request, SESSION_COOKIE);
      if (cookieId) {
        outcome = await castVotes(ip, votes, total, {
          key: sessionKey(cookieId),
        });
      }

      // 2) Sin sesión viva → exigimos un token de captcha de un solo uso.
      if (!outcome || !outcome.sessionValid) {
        if (!captchaToken || !(await validateToken(captchaToken))) {
          return json({ ok: false, reason: 'captcha_required' }, 403);
        }
        // Token válido y CONSUMIDO en Cap → ventana corta no renovable.
        const id = await createSession();
        newCookie = sessionCookie(id, false);
        outcome = await castVotes(ip, votes, total, { key: sessionKey(id) });

        // No debería fallar (la acabamos de crear), pero por si acaso.
        if (!outcome.sessionValid) {
          return json({ ok: false, reason: 'captcha_required' }, 403);
        }
      }
    }

    if (outcome.accepted === 0) {
      return json(
        {
          ok: false,
          reason: 'rate_limited',
          accepted: 0,
          blocked: outcome.blocked,
          remaining: 0,
          retryAfter: outcome.retryAfter,
        },
        429,
        newCookie,
      );
    }

    return json(
      {
        ok: true,
        counts: outcome.counts,
        accepted: outcome.accepted,
        blocked: outcome.blocked,
        remaining: outcome.remaining,
      },
      200,
      newCookie,
    );
  } catch {
    return json({ ok: false, reason: 'error' }, 500);
  }
};

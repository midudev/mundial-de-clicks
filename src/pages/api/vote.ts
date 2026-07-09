import type { APIRoute } from 'astro';
import { getClientIp } from '../../lib/rate-limit';
import { castVotes, type VoteSession } from '../../lib/votes';
import { isValidCountry } from '../../lib/countries';
import { hasCaptcha } from '../../lib/features';
import {
  readCookie,
  sessionKey,
  sessionIpKey,
  captchaSessionIp,
  SESSION_COOKIE,
  SESSION_TTL,
} from '../../lib/captcha';
import { readVoterId } from '../../lib/voter-id';
import type { VoteResponse } from '../../lib/types';

export const prerender = false;

/** Máximo de votos que aceptamos en una sola petición (anti-abuso). */
const MAX_BATCH = 10;
/** Máximo de países distintos que aceptamos en una sola petición. */
const MAX_COUNTRIES_PER_BATCH = 3;
/** Tamaño máximo del body en bytes (el payload real es diminuto). */
const MAX_BODY_BYTES = 2_048;

function json(body: VoteResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  if (process.env.NODE_ENV === 'production' && !hasCaptcha) {
    return json({ ok: false, reason: 'captcha_required' }, 503);
  }

  // Rechaza bodies desproporcionados sin buffear megas en memoria. El tope
  // se aplica leyendo el stream, no confiando en el Content-Length.
  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) {
    return json({ ok: false, reason: 'payload_too_large' }, 413);
  }

  // --- Validación de payload ----------------------------------------
  let rawVotes: Record<string, unknown>;
  try {
    const body = JSON.parse(text) as { votes?: Record<string, unknown> };
    rawVotes = body.votes ?? {};
  } catch {
    return json({ ok: false, reason: 'invalid_payload' }, 400);
  }

  // Rechazamos payloads absurdamente grandes antes de iterar nada.
  const entries = Object.entries(rawVotes);
  if (entries.length === 0 || entries.length > MAX_COUNTRIES_PER_BATCH) {
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

  // No recortamos payloads enormes: si alguien intenta meter una cantidad
  // fabricada por encima del lote esperado, rechazamos todo el envío.
  if (total > MAX_BATCH) {
    return json({ ok: false, reason: 'invalid_payload' }, 400);
  }

  // --- Captcha (solo si está activado) ------------------------------
  // Si el captcha está off, no se exige sesión: se vota directamente.
  let session: VoteSession | undefined;
  if (hasCaptcha) {
    const sessionIp = captchaSessionIp(request);
    if (!sessionIp) {
      return json({ ok: false, reason: 'captcha_required' }, 403);
    }
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (!sessionId) {
      return json({ ok: false, reason: 'captcha_required' }, 403);
    }
    session = {
      key: sessionKey(sessionId),
      ipKey: sessionIpKey(sessionId),
      ip: sessionIp,
      ttl: SESSION_TTL,
    };
  }

  // --- Procesamiento atómico (sesión + rate limit + escritura) ------
  const ip = getClientIp(request);
  const voterId = readVoterId(request);
  let outcome;
  try {
    outcome = await castVotes(ip, votes, total, session, voterId);
  } catch {
    return json({ ok: false, reason: 'error' }, 500);
  }

  // La sesión no existe/expiró: hay que volver a pasar el captcha.
  if (hasCaptcha && !outcome.sessionValid) {
    return json({ ok: false, reason: 'captcha_required' }, 403);
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
  );
};

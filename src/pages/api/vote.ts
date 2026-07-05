import type { APIRoute } from 'astro';
import { getClientIp } from '../../lib/rate-limit';
import { castVotes } from '../../lib/votes';
import { isValidCountry, COUNTRIES } from '../../lib/countries';
import type { VoteResponse } from '../../lib/types';

export const prerender = false;

/** Máximo de votos que aceptamos en una sola petición (anti-abuso). */
const MAX_BATCH = 100;
/** Máximo de claves distintas que miramos (nunca más que países). */
const MAX_KEYS = COUNTRIES.length;

function json(body: VoteResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  // --- Validación de payload ----------------------------------------
  let rawVotes: Record<string, unknown>;
  try {
    const body = (await request.json()) as { votes?: Record<string, unknown> };
    rawVotes = body.votes ?? {};
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

  // --- Procesamiento atómico (rate limit + escritura) ---------------
  const ip = getClientIp(request);
  let outcome;
  try {
    outcome = await castVotes(ip, votes, total);
  } catch {
    return json({ ok: false, reason: 'error' }, 500);
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

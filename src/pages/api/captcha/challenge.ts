import type { APIRoute } from 'astro';
import { proxyToCap } from '../../../lib/captcha';
import { hasCaptcha } from '../../../lib/features';
import { getTrustedClientIp } from '../../../lib/rate-limit';
import { consumeAbuseLimit } from '../../../lib/abuse-limit';
import { config } from '../../../lib/config';
import { readDailyVotes } from '../../../lib/daily-vote-limit';

export const prerender = false;

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function challengeDifficulty(dailyVotes: number): number {
  const base = Math.max(1, config.captcha.challengeDifficultyBase);
  const max = Math.max(base, config.captcha.challengeDifficultyMax);
  const step = Math.max(1, config.captcha.challengeDifficultyStepVotes);
  return Math.min(max, base + Math.floor(dailyVotes / step));
}

/**
 * POST /api/captcha/challenge
 * El widget pide aquí un reto. Hacemos de proxy al servidor Cap standalone.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!hasCaptcha) {
    return json({ error: 'captcha_disabled' }, 404);
  }

  const ip = getTrustedClientIp(request);
  if (!ip) {
    return json({ error: 'trusted_ip_required' }, 403);
  }

  try {
    const limit = await consumeAbuseLimit(
      'captcha:challenge',
      ip,
      config.captcha.challengeMaxPerMinute,
      60,
    );
    if (!limit.allowed) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'retry-after': String(Math.ceil(limit.retryAfter / 1000)),
        },
      });
    }
  } catch {
    return json({ error: 'rate_limit_unavailable' }, 503);
  }

  let dailyVotes = 0;
  try {
    dailyVotes = await readDailyVotes(ip);
  } catch {
    return json({ error: 'daily_limit_unavailable' }, 503);
  }

  // No reenviamos parámetros del cliente a Cap: la dificultad la fija el server.
  const body = { challengeDifficulty: challengeDifficulty(dailyVotes) };

  try {
    const { status, data } = await proxyToCap('challenge', body);
    return json(data, status);
  } catch {
    return json({ error: 'captcha_unreachable' }, 502);
  }
};

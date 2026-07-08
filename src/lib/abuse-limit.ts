import { getRedis, withTimeout } from './redis';
import { config } from './config';
import { hasDragonfly } from './features';

export interface AbuseLimitResult {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
}

const memoryWindows = new Map<string, { window: number; count: number }>();

function cleanPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 80);
}

/**
 * Limitador barato para endpoints auxiliares. No sustituye al rate limit
 * atómico del voto: frena trabajo caro antes de llegar a Cap/SSE/ranking.
 */
export async function consumeAbuseLimit(
  namespace: string,
  identity: string,
  maxPerWindow: number,
  windowSeconds: number,
): Promise<AbuseLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const window = Math.floor(now / windowMs);
  const retryAfter = (window + 1) * windowMs - now;
  const key = `ab:${cleanPart(namespace)}:${cleanPart(identity)}:${window}`;

  if (!hasDragonfly) {
    const entry = memoryWindows.get(key);
    const count = (entry?.window === window ? entry.count : 0) + 1;
    memoryWindows.set(key, { window, count });
    if (memoryWindows.size > 50_000) {
      for (const [k, v] of memoryWindows) {
        if (v.window < window) memoryWindows.delete(k);
      }
    }
    return {
      allowed: count <= maxPerWindow,
      retryAfter: count > maxPerWindow ? retryAfter : 0,
      remaining: Math.max(0, maxPerWindow - count),
    };
  }

  const redis = await getRedis();
  const count = Number(
    await withTimeout(
      redis.incr(key),
      config.redis.commandTimeoutMs,
      `abuse/${namespace}/incr`,
    ),
  );
  if (count === 1) {
    await withTimeout(
      redis.expire(key, windowSeconds + 1),
      config.redis.commandTimeoutMs,
      `abuse/${namespace}/expire`,
    );
  }

  return {
    allowed: count <= maxPerWindow,
    retryAfter: count > maxPerWindow ? retryAfter : 0,
    remaining: Math.max(0, maxPerWindow - count),
  };
}

import { getRedis, withTimeout } from './redis';
import { config } from './config';
import { hasDragonfly } from './features';

const memoryDailyVotes = new Map<string, { day: string; count: number }>();

export function currentUtcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsUntilNextUtcDay(now = Date.now()): number {
  const date = new Date(now);
  const next = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export function dailyVoteKey(ip: string, day = currentUtcDay()): string {
  return `daily:${ip}:${day}`;
}

/** Lee votos diarios ya contados para una IP. */
export async function readDailyVotes(ip: string): Promise<number> {
  const day = currentUtcDay();
  if (!hasDragonfly) {
    const entry = memoryDailyVotes.get(ip);
    return entry?.day === day ? entry.count : 0;
  }

  const redis = await getRedis();
  const value = await withTimeout(
    redis.get(dailyVoteKey(ip, day)),
    config.redis.commandTimeoutMs,
    'dailyVotes/get',
  );
  return Number(value ?? 0);
}

export function incrementDailyVotesMemory(ip: string, accepted: number): void {
  if (accepted <= 0) return;
  const day = currentUtcDay();
  const entry = memoryDailyVotes.get(ip);
  const count = entry?.day === day ? entry.count : 0;
  memoryDailyVotes.set(ip, { day, count: count + accepted });
}

import { getRedis, withTimeout } from './redis';
import { config } from './config';
import { hasDragonfly } from './features';

const memoryDailyVotes = new Map<string, { day: string; count: number }>();

function cleanPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 100);
}

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

export function dailyVoteKey(scope: string, identity: string, day = currentUtcDay()): string {
  return `daily:${cleanPart(scope)}:${cleanPart(identity)}:${day}`;
}

/** Lee votos diarios ya contados para una identidad. */
export async function readDailyVotes(
  scope: string,
  identity: string,
): Promise<number> {
  const day = currentUtcDay();
  const key = dailyVoteKey(scope, identity, day);
  if (!hasDragonfly) {
    const entry = memoryDailyVotes.get(key);
    return entry?.day === day ? entry.count : 0;
  }

  const redis = await getRedis();
  const value = await withTimeout(
    redis.get(key),
    config.redis.commandTimeoutMs,
    'dailyVotes/get',
  );
  return Number(value ?? 0);
}

export async function readDailyVotesMax(
  identities: Array<[scope: string, identity: string | null]>,
): Promise<number> {
  const counts = await Promise.all(
    identities
      .filter((entry): entry is [string, string] => !!entry[1])
      .map(([scope, identity]) => readDailyVotes(scope, identity)),
  );
  return Math.max(0, ...counts);
}

export function incrementDailyVotesMemory(
  identities: Array<[scope: string, identity: string | null]>,
  accepted: number,
): void {
  if (accepted <= 0) return;
  const day = currentUtcDay();
  for (const [scope, identity] of identities) {
    if (!identity) continue;
    const key = dailyVoteKey(scope, identity, day);
    const entry = memoryDailyVotes.get(key);
    const count = entry?.day === day ? entry.count : 0;
    memoryDailyVotes.set(key, { day, count: count + accepted });
  }
}

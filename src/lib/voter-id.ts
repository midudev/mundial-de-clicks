import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { readCookie } from './captcha';

export const VOTER_COOKIE = 'voter_id';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

function secret(): string {
  const configured = config.security.voterIdSecret || config.security.originGuardSecret;
  if (configured) return configured;
  if (process.env.NODE_ENV !== 'production') return 'dev-voter-id-secret';
  return '';
}

export function hasVoterIdSecret(): boolean {
  return secret() !== '';
}

function sign(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('base64url');
}

function encode(id: string): string {
  if (!hasVoterIdSecret()) {
    throw new Error('missing voter id signing secret');
  }
  return `${id}.${sign(id)}`;
}

function decode(value: string): string | null {
  const key = secret();
  if (!key) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const expected = sign(id);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? id : null;
}

export function readVoterId(request: Request): string | null {
  const cookie = readCookie(request, VOTER_COOKIE);
  return cookie ? decode(cookie) : null;
}

export function createVoterId(): string {
  return randomUUID();
}

export function voterCookie(id: string, secure: boolean): string {
  const attrs = [
    `${VOTER_COOKIE}=${encode(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

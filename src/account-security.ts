// Shared authentication primitives. No secrets are kept in Worker memory between requests.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { cookie, cookies, hash, randomToken, safeNext, sessionCookies, type User } from './auth.ts';
import type { Env } from './index.ts';

export const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 3, dkLen: 32, maxmem: 48 * 1024 * 1024 };
const encoder = new TextEncoder();
export function passwordError(password: string): string | null {
  if ([...password].length < 15 || [...password].length > 128 || encoder.encode(password).length > 512) return 'Use a password between 15 and 128 characters.';
  return null;
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16));
}
// A Worker isolate has a shared memory limit. Serialize the ~32 MiB hash work,
// and bound its queue so simultaneous requests cannot exhaust isolate memory.
export class AuthBusyError extends Error {}
let hashing = false;
const hashQueue: Array<() => void> = [];
export async function passwordHash(password: string, salt = randomToken()): Promise<string> {
  if (hashing) {
    if (hashQueue.length >= 2) throw new AuthBusyError('Authentication is busy. Try again shortly.');
    await new Promise<void>(resolve => hashQueue.push(resolve));
  } else hashing = true;
  try {
    const key = await scryptAsync(password, salt, PASSWORD_OPTIONS);
    try { return `scrypt:32768:8:3:${salt}:${hex(key)}`; } finally { key.fill(0); }
  } finally {
    const next = hashQueue.shift();
    if (next) next(); else hashing = false;
  }
}
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  if (encoder.encode(password).length > 512) return false;
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts.slice(0, 4).join(':') !== 'scrypt:32768:8:3' || !/^[0-9a-f]{64}$/.test(parts[5])) return false;
  const actual = await passwordHash(password, parts[4]);
  let diff = actual.length ^ encoded.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (encoded.charCodeAt(i) || 0);
  return diff === 0;
}
// A real scrypt invocation for unknown users too, avoiding a fast account-existence oracle.
export const DUMMY_HASH = 'scrypt:32768:8:3:unknown-account-dummy-salt:' + '0'.repeat(64);

export interface Flow { token_hash: string; purpose: string; user_id: string | null; auth_version: number; data: string; expires_at: number }
export async function version(env: Env, id: string): Promise<number> {
  return (await env.DB.prepare('SELECT auth_version FROM users WHERE id = ? AND banned = 0').bind(id).first<{auth_version: number}>())?.auth_version ?? -1;
}
export async function makeFlow(env: Env, purpose: string, id: string | null, data: object, seconds = 600, expectedVersion?: number): Promise<string> {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO auth_flows (token_hash, purpose, user_id, auth_version, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await hash(token), purpose, id, id ? (expectedVersion ?? await version(env, id)) : 0, JSON.stringify(data), Date.now() + seconds * 1000).run();
  return token;
}
export async function readFlow(env: Env, token: string, purpose: string, consume = false): Promise<Flow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare(`${consume ? 'DELETE FROM' : 'SELECT * FROM'} auth_flows WHERE token_hash = ? AND purpose = ? AND expires_at > ?
    AND (user_id IS NULL OR EXISTS (SELECT 1 FROM users WHERE users.id = auth_flows.user_id AND users.banned = 0 AND users.auth_version = auth_flows.auth_version)) ${consume ? 'RETURNING *' : ''}`)
    .bind(await hash(token), purpose, Date.now()).first<Flow>();
}
export function flowCookie(value: string, seconds = 600, name = '__Host-auth-flow'): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
}
export function flowToken(req: Request, name = '__Host-auth-flow'): string { return cookie(req, name) ?? ''; }
export function redirect(path: string, flow?: string): Response {
  const headers = new Headers({ Location: path, 'Cache-Control': 'no-store' });
  if (flow !== undefined) headers.append('Set-Cookie', flowCookie(flow, flow ? 600 : 0));
  return new Response(null, { status: 303, headers });
}
export async function issueSession(env: Env, id: string, authVersion: number, strength: string, next = '/account/security', unlockedAt?: number): Promise<Response> {
  const state = await env.DB.prepare('SELECT deactivated_at FROM users WHERE id = ? AND auth_version = ? AND banned = 0 AND deleted_at = 0').bind(id,authVersion).first<{deactivated_at:number}>();
  if (state?.deactivated_at) {
    const intent = await makeFlow(env,'reactivate',id,{strength},600,authVersion);
    const response = redirect('/account/reactivate');
    response.headers.append('Set-Cookie',flowCookie(intent,600,'__Host-reactivation'));
    return response;
  }
  const token = randomToken();
  const now = Date.now();
  const target = new URL(safeNext(next, env), env.SITE_URL);
  let unlock = target.origin === new URL(env.SITE_URL).origin && target.pathname === '/account/security' ? (unlockedAt ?? now) : 0;
  if (target.pathname === '/account/unlock/complete') {
    const intent = await readFlow(env, target.searchParams.get('token') ?? '', 'settings-unlock');
    if (!intent || intent.user_id !== id || intent.auth_version !== authVersion) return new Response('Use a sign-in method belonging to this account.', {status: 403});
    // The completion endpoint verifies this fresh session against its browser-bound intent.
    unlock = 0;
  }
  const result = await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at, auth_strength, security_unlocked_at, security_last_used_at)
    SELECT ?, id, ?, ?, ?, ?, ? FROM users WHERE id = ? AND auth_version = ? AND banned = 0 AND deactivated_at = 0 AND deleted_at = 0`)
    .bind(await hash(token), now + 30 * 86400_000, now, strength, unlock, unlock ? now : 0, id, authVersion).run();
  if (result.meta.changes !== 1) return new Response('Sign-in expired. Try again.', { status: 401 });
  const headers = new Headers({ Location: safeNext(next, env), 'Cache-Control': 'no-store' });
  for (const c of sessionCookies(env, token, 30 * 86400)) headers.append('Set-Cookie', c);
  headers.append('Set-Cookie', flowCookie('', 0));
  headers.append('Set-Cookie', flowCookie('', 0, '__Host-passkey-flow'));
  return new Response(null, { status: 303, headers });
}
export async function finishPrimary(env: Env, id: string, authVersion: number, next: string): Promise<Response> {
  const enrolled = await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ? UNION ALL SELECT 1 FROM totp_credentials WHERE user_id = ? LIMIT 1').bind(id, id).first();
  if (!enrolled) return issueSession(env, id, authVersion, 'primary', next);
  if (await version(env, id) !== authVersion) return new Response('Sign-in expired. Try again.', { status: 401 });
  const token = await makeFlow(env, 'second-factor', id, { next });
  // makeFlow captures the current version; don't upgrade a stale primary proof after a reset.
  if (await version(env, id) !== authVersion) return new Response('Sign-in expired. Try again.', { status: 401 });
  return redirect('/auth/second-factor', token);
}
export const SECURITY_IDLE_MS = 30 * 60_000;
export const SECURITY_MAX_MS = 60 * 60_000;
export interface SecuritySession { token_hash: string; auth_version: number; auth_strength: string; security_unlocked_at: number }
export async function securitySession(req: Request, env: Env, user: User, requireMfa = false): Promise<SecuritySession | null> {
  const now = Date.now();
  for (const token of cookies(req, 'session').slice(0, 2)) {
    const row = await env.DB.prepare(`UPDATE sessions SET security_last_used_at = ? WHERE token_hash = ? AND user_id = ? AND kind = 'web'
      AND expires_at > ? AND security_unlocked_at > ? AND security_last_used_at > ?
      AND EXISTS (SELECT 1 FROM users WHERE id = sessions.user_id AND banned = 0 AND deactivated_at = 0 AND deleted_at = 0)
      AND (auth_strength IN ('strong','totp') OR (? = 0 AND (auth_strength = 'recovery' OR
        (auth_strength = 'primary' AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = sessions.user_id)
        AND NOT EXISTS (SELECT 1 FROM totp_credentials WHERE user_id = sessions.user_id)))))
      RETURNING token_hash, auth_strength, security_unlocked_at, (SELECT auth_version FROM users WHERE id = sessions.user_id) AS auth_version`)
      .bind(now, await hash(token), user.id, now, now - SECURITY_MAX_MS, now - SECURITY_IDLE_MS, requireMfa ? 1 : 0).first<SecuritySession>();
    if (row) return row;
  }
  return null;
}
export async function securityProof(req: Request, env: Env, user: User, requireMfa = false): Promise<boolean> {
  return !!await securitySession(req, env, user, requireMfa);
}

/** Atomic shared limits, enforced before expensive hashes, also behind multiple Worker instances. */
export async function limit(env: Env, scope: string, identity: string, max: number, seconds = 900): Promise<boolean> {
  const now = Date.now();
  const key = await hash(`${scope}:${identity}`);
  const row = await env.DB.prepare(`INSERT INTO auth_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
    .bind(key, now + seconds * 1000, now, now).first<{count: number}>();
  return !!row && row.count <= max;
}
export async function boundedBody(req: Request, maxBytes = 20000): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes);
  if (req.headers.get('Content-Type')?.split(';')[0] === 'application/json') {
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid body');
    return json as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Range lookup sends only five hex characters of SHA-1, never the password. Fail closed. */
export async function newPasswordError(password: string): Promise<string | null> {
  const invalid = passwordError(password);
  if (invalid) return invalid;
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(password)))).toUpperCase();
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Password screening unavailable');
    if ((await response.text()).split('\n').some(line => line.trim().split(':')[0] === digest.slice(5) && Number(line.trim().split(':')[1]) > 0)) {
      return 'This password appears in known breaches. Choose a different password.';
    }
    return null;
  } catch { return 'Password safety checks are temporarily unavailable. Try again later.'; }
}

/** All dependent credentials are invalidated in the same D1 transaction as a password change. */
export async function replacePassword(env: Env, flow: Flow, encoded: string): Promise<boolean> {
  const exists = 'EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)';
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE email_credentials SET password_hash = ? WHERE user_id = ? AND ${exists} AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ? AND banned = 0)`)
      .bind(encoded, flow.user_id, flow.token_hash, now, flow.user_id, flow.auth_version),
    env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${exists}`).bind(flow.user_id, flow.token_hash, now),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${exists}`).bind(flow.user_id, flow.token_hash, now),
    env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${exists}`).bind(flow.user_id, flow.token_hash, now),
    env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${exists}`).bind(flow.user_id, flow.token_hash, now),
  ]);
  return results[0].meta.changes === 1;
}

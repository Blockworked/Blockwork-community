import * as OTPAuth from 'otpauth';
import qrcode from 'qrcode-generator';
import type { Env } from './index.ts';
import { type User } from './auth.ts';
import { esc } from './pages.ts';
import { accountPage } from './account-views.ts';
import { flowCookie, flowToken, issueSession, limit, makeFlow, readFlow, recentProof, unhex, hex } from './account-security.ts';
import { notify } from './account-mail.ts';
import { json } from './passkeys.ts';

const issuer = 'Blockworked';
const aad = (id: string) => new TextEncoder().encode(`blockworked:totp:v1:${id}`);
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const value = env.AUTH_TOTP_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('TOTP encryption key is unavailable');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealSecret(env: Env, id: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad(id)}, await encryptionKey(env), new TextEncoder().encode(secret));
  return `v1:${hex(iv)}:${hex(new Uint8Array(encrypted))}`;
}
export async function openSecret(env: Env, id: string, encrypted: string): Promise<string> {
  const [v, iv, value] = encrypted.split(':');
  if (v !== 'v1' || !/^[a-f0-9]{24}$/.test(iv) || !/^[a-f0-9]+$/.test(value)) throw new Error('Invalid encrypted secret');
  const decrypted = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unhex(iv), additionalData: aad(id)}, await encryptionKey(env), unhex(value));
  return new TextDecoder().decode(decrypted);
}
export function totp(secret: string, label = 'Account'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({issuer, label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret)});
}
export function acceptedStep(secret: string, token: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totp(secret).validate({token, timestamp: now, window: 1});
  return delta === null ? null : Math.floor(now / 30000) + delta;
}
const fail = (text = 'Code is invalid, expired or already used. Start sign-in again and use a fresh code.') => json({error: text}, 400);
async function sessionJson(env: Env, user: string, version: number, next: string): Promise<Response> {
  const response = await issueSession(env, user, version, 'totp', next);
  if (response.status !== 303) return fail();
  const headers = new Headers(response.headers);
  const destination = headers.get('Location');
  headers.delete('Location'); headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({next: destination}), {headers});
}
export async function totpRoute(req: Request, env: Env, path: string, body: Record<string, unknown>, user: User | null): Promise<Response> {
  if (!env.AUTH_TOTP_KEY) return json({error: 'Authenticator apps are not configured yet.'}, 503);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (path === '/auth/totp/verify') {
    const flow = await readFlow(env, flowToken(req), 'second-factor');
    if (!flow?.user_id) return fail();
    if (!await limit(env, 'totp-user', flow.user_id, 8, 300)) return json({error: 'Too many attempts. Try again in five minutes.'}, 429);
    const row = await env.DB.prepare('SELECT encrypted_secret, last_step FROM totp_credentials WHERE user_id = ?').bind(flow.user_id)
      .first<{encrypted_secret: string; last_step: number}>();
    if (!row) return fail();
    let step: number | null;
    try { step = acceptedStep(await openSecret(env, flow.user_id, row.encrypted_secret), code); } catch { return fail(); }
    if (step === null || step <= row.last_step) return fail();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE totp_credentials SET last_step = ? WHERE user_id = ? AND last_step < ? AND encrypted_secret = ?
        AND EXISTS (SELECT 1 FROM auth_flows f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND f.expires_at > ? AND u.auth_version = f.auth_version AND u.banned = 0)`)
        .bind(step, flow.user_id, step, row.encrypted_secret, flow.token_hash, Date.now()),
      env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ?').bind(flow.token_hash),
    ]);
    if (results[0].meta.changes !== 1) return fail();
    return sessionJson(env, flow.user_id, flow.auth_version, JSON.parse(flow.data).next);
  }
  if (!user || !await recentProof(req, env, user)) return json({error: 'Sign in again before changing your authenticator app.'}, 401);
  if (path === '/account/totp/setup') {
    const secret = new OTPAuth.Secret({size: 20}).base32;
    const encrypted = await sealSecret(env, user.id, secret);
    const token = await makeFlow(env, 'totp-enroll', user.id, {encrypted}, 600);
    if (!await recentProof(req, env, user)) return fail();
    const qr = qrcode(0, 'M');
    qr.addData(totp(secret, user.name).toString()); qr.make();
    const response = accountPage(user, env, 'Set up an authenticator app', `<p>Scan this code in an authenticator app such as Aegis, 2FAS, Google Authenticator, or Microsoft Authenticator.</p>
      <div style="background:white;color:black;width:min(100%,320px);padding:12px">${qr.createSvgTag({scalable: true})}</div>
      <p>Or enter this setup key manually. Keep it private:</p><pre>${esc(secret)}</pre>
      <form method="post" action="/account/totp/confirm"><p><label>Six-digit code <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required></label></p><button>Confirm authenticator app</button></form>
      <p>The app is activated only after you confirm a code. This replaces any existing authenticator app and signs out other browsers and apps.</p>`);
    response.headers.append('Set-Cookie', flowCookie(token, 600, '__Host-totp-enroll'));
    return response;
  }
  if (path === '/account/totp/confirm') {
    if (!await limit(env, 'totp-enroll-user', user.id, 8, 300)) return fail('Too many attempts. Try again in five minutes.');
    const flow = await readFlow(env, flowToken(req, '__Host-totp-enroll'), 'totp-enroll');
    if (!flow || flow.user_id !== user.id) return fail();
    const encrypted = JSON.parse(flow.data).encrypted;
    const step = acceptedStep(await openSecret(env, user.id, encrypted), code);
    if (step === null) return accountPage(user, env, 'Authenticator app not confirmed', '<p>The code was incorrect or expired. Return to the setup page and try a fresh code, or start setup again from Account security.</p>', 400);
    const now = Date.now();
    const exists = 'EXISTS (SELECT 1 FROM auth_flows f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND f.expires_at > ? AND u.auth_version = f.auth_version AND u.banned = 0)';
    const guard = 'EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)';
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO totp_credentials (user_id, encrypted_secret, last_step, created_at) SELECT ?, ?, ?, ? WHERE ${exists}
        ON CONFLICT(user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, last_step = excluded.last_step, created_at = excluded.created_at`)
        .bind(user.id, encrypted, step, now, flow.token_hash, now),
      env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
    ]);
    if (results[0].meta.changes !== 1) return fail();
    await notify(env, user.id, 'An authenticator app was enabled or replaced on your Blockworked account. Other browsers and apps have been signed out. Save backup codes in Account security.');
    return issueSession(env, user.id, flow.auth_version + 1, 'totp', '/account');
  }
  if (path === '/account/totp/delete') {
    if (!await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').bind(user.id).first()) return fail('Add a passkey before removing your last authenticator app. You can replace the app by setting up a new one.');
    const token = await makeFlow(env, 'totp-delete', user.id, {});
    if (!await recentProof(req, env, user)) return fail();
    const flow = await readFlow(env, token, 'totp-delete');
    if (!flow) return fail();
    const guard = 'EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)';
    const now = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM totp_credentials WHERE user_id = ? AND EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?) AND ${guard}`).bind(user.id, user.id, flow.token_hash, now),
      env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
    ]);
    if (results[0].meta.changes !== 1) return fail();
    await notify(env, user.id, 'An authenticator app was removed from your Blockworked account. All browsers and apps have been signed out.');
    return new Response(null, {status: 303, headers: {Location: '/login?next=%2Faccount'}});
  }
  return json({error: 'Not found'}, 404);
}

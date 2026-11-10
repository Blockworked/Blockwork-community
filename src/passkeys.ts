import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransport } from '@simplewebauthn/server';
import type { Env } from './index.ts';
import { notify } from './account-mail.ts';
import { currentUser, hash, safeNext } from './auth.ts';
import { flowCookie, flowToken, hex, issueSession, makeFlow, readFlow, securityProof, securitySession, unhex, type Flow } from './account-security.ts';

interface Key { id: string; user_id: string; public_key: string; counter: number; transports: string; label: string; auth_version: number }
export function json(data: unknown, status = 200, token?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (token !== undefined) headers.set('Set-Cookie', flowCookie(token, token ? 600 : 0, '__Host-passkey-flow'));
  return new Response(JSON.stringify(data), {status, headers});
}
const fail = () => json({error: 'Verification expired or failed. Sign in and try again.'}, 400);
function rp(env: Env): { rpID: string; expectedOrigin: string } {
  const url = new URL(env.SITE_URL);
  return {rpID: url.hostname, expectedOrigin: url.origin};
}
/** The session insert checks the credential generation captured before verification. */
async function complete(env: Env, flow: Flow, id: string, strength: string, next: string, unlockedAt?: number): Promise<Response> {
  if (flow.user_id && flow.user_id !== id) return fail();
  const user = await env.DB.prepare('SELECT auth_version FROM users WHERE id = ? AND banned = 0').bind(id).first<{auth_version: number}>();
  if (!user || (flow.user_id && user.auth_version !== flow.auth_version)) return fail();
  const res = await issueSession(env, id, user.auth_version, strength, next, unlockedAt);
  if (res.status !== 303) return fail();
  const headers = new Headers(res.headers);
  const destination = headers.get('Location');
  headers.delete('Location');
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({next: destination}), {headers});
}
export async function passkeyRoute(req: Request, env: Env, path: string, body: Record<string, unknown>): Promise<Response> {
  const {rpID, expectedOrigin} = rp(env);
  if (path === '/auth/passkey/options') {
    const second = await readFlow(env, flowToken(req), 'second-factor');
    const keys = second ? await env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').bind(second.user_id).all<Key>() : null;
    const options = await generateAuthenticationOptions({rpID, userVerification: 'required',
      ...(keys ? {allowCredentials: keys.results.map(k => ({id: k.id, transports: JSON.parse(k.transports)}))} : {})});
    const token = await makeFlow(env, 'passkey-login', second?.user_id ?? null,
      {challenge: options.challenge, parent: second ? flowToken(req) : null, next: second ? JSON.parse(second.data).next : safeNext(String(body.next ?? '/account/security'), env)});
    return json(options, 200, token);
  }
  if (path === '/auth/passkey/verify') {
    const flow = await readFlow(env, flowToken(req, '__Host-passkey-flow'), 'passkey-login', true);
    if (!flow) return fail();
    const response = body as unknown as AuthenticationResponseJSON;
    if (typeof response.id !== 'string') return fail();
    const key = await env.DB.prepare('SELECT p.*, u.auth_version FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.banned = 0').bind(response.id).first<Key>();
    if (!key || (flow.user_id && key.user_id !== flow.user_id)) return fail();
    const data = JSON.parse(flow.data);
    try {
      const result = await verifyAuthenticationResponse({response, expectedChallenge: data.challenge, expectedOrigin, expectedRPID: rpID,
        requireUserVerification: true, credential: {id: key.id, publicKey: unhex(key.public_key), counter: key.counter, transports: JSON.parse(key.transports)}});
      if (!result.verified) return fail();
      // CAS prevents concurrent assertions from overwriting a newer counter. Zero is valid for synced passkeys.
      const update = await env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ? AND counter = ?')
        .bind(result.authenticationInfo.newCounter, key.id, key.counter).run();
      if (update.meta.changes !== 1) return fail();
      if (data.parent && !await readFlow(env, data.parent, 'second-factor', true)) return fail();
      return complete(env, {...flow, user_id: key.user_id, auth_version: flow.user_id ? flow.auth_version : key.auth_version}, key.user_id, 'strong', data.next);
    } catch { return fail(); }
  }
  if (path === '/auth/passkey/register-options' || path === '/auth/passkey/register-verify') {
    const user = await currentUser(req, env);
    const proof = user ? await securitySession(req, env, user) : null;
    if (!user || !proof) return json({error: 'Unlock Account security before changing security settings.'}, 401);
    if (path.endsWith('register-options')) {
      const keys = await env.DB.prepare('SELECT id FROM passkeys WHERE user_id = ?').bind(user.id).all<Key>();
      if (keys.results.length >= 10) return json({error: 'You can register up to 10 passkeys.'}, 400);
      const options = await generateRegistrationOptions({rpName: 'Blockworked', rpID,
        // An opaque, stable handle under WebAuthn's 64-byte limit, also for provider-based IDs.
        userID: unhex(await hash(user.id)), userName: user.name,
        attestationType: 'none', authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
        excludeCredentials: keys.results.map(k => ({id: k.id})), supportedAlgorithmIDs: [-7, -257]});
      const token = await makeFlow(env, 'passkey-register', user.id, {challenge: options.challenge, label: String(body.label || 'Passkey').slice(0, 80)});
      if (!await securityProof(req, env, user)) return fail();
      return json(options, 200, token);
    }
    const flow = await readFlow(env, flowToken(req, '__Host-passkey-flow'), 'passkey-register', true);
    if (!flow || flow.user_id !== user.id) return fail();
    try {
      const data = JSON.parse(flow.data);
      const result = await verifyRegistrationResponse({response: body as unknown as RegistrationResponseJSON, expectedChallenge: data.challenge,
        expectedOrigin, expectedRPID: rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257]});
      if (!result.verified || !result.registrationInfo) return fail();
      const key = result.registrationInfo.credential;
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, label, created_at)
          SELECT ?, id, ?, ?, ?, ?, ? FROM users WHERE id = ? AND auth_version = ? AND banned = 0`)
          .bind(key.id, hex(key.publicKey), key.counter, JSON.stringify(key.transports ?? [] satisfies AuthenticatorTransport[]), data.label, Date.now(), user.id, flow.auth_version),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?)').bind(user.id, key.id),
        env.DB.prepare('DELETE FROM app_codes WHERE user_id = ? AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?)').bind(user.id, key.id),
        env.DB.prepare('DELETE FROM auth_flows WHERE user_id = ? AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?)').bind(user.id, key.id),
        env.DB.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?').bind(user.id, flow.auth_version),
      ]);
      if (results[0].meta.changes !== 1) return fail();
      await notify(env, user.id, 'A passkey was added to your Blockworked account. Other browsers and apps have been signed out. Save backup codes in Account security.');
      return complete(env, {...flow, auth_version: flow.auth_version + 1}, user.id, 'strong', '/account/security?enrolled=1', proof.security_unlocked_at);
    } catch { return fail(); }
  }
  if (path === '/auth/backup/verify') {
    const flow = await readFlow(env, flowToken(req), 'second-factor', true);
    if (!flow?.user_id || typeof body.code !== 'string') return fail();
    const consumed = await env.DB.prepare(`DELETE FROM backup_codes WHERE user_id = ? AND code_hash = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ?) RETURNING code_hash`)
      .bind(flow.user_id, await hash(body.code.trim().replace(/-/g, '').toLowerCase()), flow.user_id, flow.auth_version).first();
    if (!consumed) return fail();
    await notify(env, flow.user_id, 'A backup code was used to sign in to your Blockworked account. If a device was lost, add a replacement passkey and remove the old one in Account security.');
    return complete(env, flow, flow.user_id, 'recovery', JSON.parse(flow.data).next);
  }
  return json({error: 'Not found'}, 404);
}

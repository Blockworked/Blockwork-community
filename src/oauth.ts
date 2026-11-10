// Provider identities are independent from account IDs. Email is never a linking signal.
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import type { Env } from './index.ts';
import { cookie, currentUser, isAdmin, isReservedName, randomToken, safeNext, PROVIDERS, type Provider, type User } from './auth.ts';
import { finishPrimary, issueSession, limit, makeFlow, readFlow, securitySession } from './account-security.ts';
import { accountPage } from './account-views.ts';
import { esc } from './pages.ts';
import { notify } from './account-mail.ts';
import { CHANGE_GATE, commitCredentialChange } from './credential-change.ts';

const STATE_COOKIE = '__Host-oauth-state';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
  timeoutDuration: 10000, [customFetch]: (...args) => fetch(...args),
});
function stateCookie(token: string): string {
  return `${STATE_COOKIE}=${token}; Path=/; Max-Age=${token ? 600 : 0}; HttpOnly; Secure; SameSite=Lax`;
}
const callbackUri = (env: Env, provider: Provider) => `${new URL(env.SITE_URL).origin}/auth/${provider}/callback`;
function failure(env: Env, text = 'This connection expired or could not be verified. Try again from Account security.', status = 400): Response {
  const response = accountPage(null, env, 'Account connection', `<p role="alert">${esc(text)}</p><p><a href="/account/security">Account security</a></p>`, status);
  response.headers.append('Set-Cookie', stateCookie(''));
  return response;
}
async function authorize(env: Env, provider: Provider, next: string, user?: User, session?: Awaited<ReturnType<typeof securitySession>>): Promise<Response> {
  const verifier = randomToken();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = await makeFlow(env, user ? 'oauth-link' : 'oauth-login', user?.id ?? null,
    {provider, next, verifier, nonce: randomToken(), session_hash: session?.token_hash}, 600, session?.auth_version);
  const flow = (await readFlow(env, token, user ? 'oauth-link' : 'oauth-login'))!;
  if (!flow) return failure(env);
  const url = new URL(provider === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', provider === 'github' ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', callbackUri(env, provider));
  url.searchParams.set('state', token);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'github') {
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('allow_signup', user ? 'false' : 'true');
  } else {
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile');
    url.searchParams.set('nonce', JSON.parse(flow.data).nonce);
    url.searchParams.set('prompt', 'select_account');
  }
  return new Response(null, {status: 302, headers: {Location: url.toString(), 'Set-Cookie': stateCookie(token), 'Cache-Control': 'no-store'}});
}
export async function login(env: Env, provider: Provider, next: string | null): Promise<Response> {
  return authorize(env, provider, safeNext(next, env));
}
async function providerJson<T>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Provider verification failed');
  return response.json<T>();
}
async function fetchProfile(env: Env, provider: Provider, code: string, data: {verifier: string; nonce: string}): Promise<{id: string; subject: string; name: string; avatar: string}> {
  if (provider === 'github') {
    const token = await providerJson<{access_token?: string}>('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
      body: JSON.stringify({client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
        redirect_uri: callbackUri(env, provider), code_verifier: data.verifier}),
    });
    if (!token.access_token) throw new Error('Provider verification failed');
    const me = await providerJson<{id: number; login: string; name?: string; avatar_url?: string}>('https://api.github.com/user', {
      headers: {Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'blockwork-library', Accept: 'application/json'},
    });
    if (!Number.isSafeInteger(me.id) || me.id <= 0 || typeof me.login !== 'string') throw new Error('Provider verification failed');
    return {id: `github:${me.id}`, subject: String(me.id), name: (me.name || me.login).slice(0, 80), avatar: me.avatar_url ?? ''};
  }
  const token = await providerJson<{access_token?: string; id_token?: string}>('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code,
      redirect_uri: callbackUri(env, provider), grant_type: 'authorization_code', code_verifier: data.verifier}),
  });
  if (!token.access_token || !token.id_token) throw new Error('Provider verification failed');
  const {payload} = await jwtVerify(token.id_token, googleKeys, {issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID, algorithms: ['RS256'], maxTokenAge: '10m', clockTolerance: 30});
  if ((payload.azp !== undefined && payload.azp !== env.GOOGLE_CLIENT_ID) || payload.nonce !== data.nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('Provider verification failed');
  const me = await providerJson<{sub?: string; name?: string; picture?: string}>('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {Authorization: `Bearer ${token.access_token}`},
  });
  if (me.sub !== payload.sub) throw new Error('Provider verification failed');
  return {id: `google:${payload.sub}`, subject: payload.sub, name: (me.name || 'Google user').slice(0, 80), avatar: me.picture ?? ''};
}
export async function callback(req: Request, env: Env, provider: Provider): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  if (!state || cookie(req, STATE_COOKIE) !== state || !code || code.length > 2048) return failure(env);
  let flow = await readFlow(env, state, 'oauth-link');
  const linking = !!flow;
  flow ??= await readFlow(env, state, 'oauth-login');
  if (!flow || JSON.parse(flow.data).provider !== provider) return failure(env);
  const user = linking ? await currentUser(req, env) : null;
  const proof = user ? await securitySession(req, env, user) : null;
  if (linking && (!user || flow.user_id !== user.id || !proof || proof.token_hash !== JSON.parse(flow.data).session_hash)) return failure(env);
  flow = await readFlow(env, state, linking ? 'oauth-link' : 'oauth-login', true);
  if (!flow) return failure(env);
  const data = JSON.parse(flow.data);
  let profile: Awaited<ReturnType<typeof fetchProfile>>;
  try { profile = await fetchProfile(env, provider, code, data); } catch { return failure(env, 'The provider could not verify this sign-in. Try again.', 401); }
  if (linking) {
    const token = await makeFlow(env, 'oauth-confirm', user!.id, {provider, subject: profile.subject, label: profile.name, session_hash: proof!.token_hash}, 600, flow.auth_version);
    const response = accountPage(user, env, 'Confirm account connection', `<p>Connect ${esc(PROVIDERS[provider])} account <strong>${esc(profile.name)}</strong> to <strong>${esc(user!.name)}</strong>?</p>
      <p>This lets you sign into this same Blockworked account with ${esc(PROVIDERS[provider])}. Your existing MFA remains required.</p>
      <form method="post" action="/account/oauth/confirm"><input type="hidden" name="token" value="${esc(token)}"><button>Connect ${esc(PROVIDERS[provider])}</button></form><p><a href="/account/security">Cancel</a></p>`);
    response.headers.append('Set-Cookie', stateCookie(''));
    return response;
  }
  interface Identity { user_id: string; auth_version: number; banned: number }
  const find = () => env.DB.prepare(`SELECT i.user_id, u.auth_version, u.banned FROM oauth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?`)
    .bind(provider, profile.subject).first<Identity>();
  let identity = await find();
  const next = safeNext(data.next, env);
  if (!identity) {
    // A security-settings re-auth must use an identity already belonging to this account.
    if (new URL(next, env.SITE_URL).pathname === '/account/unlock/complete') return failure(env, 'Use a sign-in method already connected to your account.', 403);
    if (isReservedName(profile.name) && !isAdmin(env, {id: profile.id, name: profile.name, avatar: '', banned: 0})) return failure(env, 'This display name is reserved for the Blockworked team.', 403);
    const used = await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(profile.id).first();
    const id = used ? `account:${crypto.randomUUID()}` : profile.id;
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, name, avatar, created_at, public_id) SELECT ?, ?, ?, ?, lower(hex(randomblob(6))) WHERE NOT EXISTS (SELECT 1 FROM oauth_identities WHERE provider = ? AND subject = ?)').bind(id, profile.name, profile.avatar, now, provider, profile.subject),
        env.DB.prepare('INSERT INTO oauth_identities (provider, subject, user_id, label, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT DO NOTHING').bind(provider, profile.subject, id, profile.name, now, id),
      ]);
    } catch { /* A concurrent first sign-in may already have created this identity. */ }
    identity = await find();
  }
  if (!identity || identity.banned) return failure(env, 'This account cannot sign in.', 403);
  const response = await finishPrimary(env, identity.user_id, identity.auth_version, next);
  response.headers.append('Set-Cookie', stateCookie(''));
  return response;
}

export async function oauthSettings(req: Request, env: Env, user: User | null, path: string, body: Record<string, unknown>): Promise<Response> {
  const proof = user ? await securitySession(req, env, user) : null;
  if (!user || !proof) return failure(env, 'Unlock Account security before changing connections.', 401);
  if (!await limit(env, 'oauth-settings', user.id, 15, 3600)) return failure(env, 'Too many connection changes. Try again in an hour.', 429);
  const match = /^\/account\/oauth\/(github|google)\/(connect|disconnect)$/.exec(path);
  if (match?.[2] === 'connect') {
    const started = await authorize(env, match[1] as Provider, '/account/security', user, proof);
    const authorization = started.headers.get('Location');
    if (!authorization) return started;
    // Navigate from first-party JS or an explicit link. A form redirect to a
    // provider is deliberately blocked by our form-action 'self' CSP.
    const response = req.headers.get('Content-Type')?.startsWith('application/json')
      ? new Response(JSON.stringify({authorization}), {headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}})
      : accountPage(user, env, 'Connect sign-in account', `<p><a class="button" href="${esc(authorization)}">Continue to ${esc(PROVIDERS[match[1] as Provider])}</a></p>`);
    for (const value of started.headers.getSetCookie()) response.headers.append('Set-Cookie', value);
    return response;
  }
  if (path === '/account/oauth/confirm') {
    const flow = await readFlow(env, typeof body.token === 'string' ? body.token : '', 'oauth-confirm');
    if (!flow || flow.user_id !== user.id) return failure(env);
    const data = JSON.parse(flow.data);
    if (data.session_hash !== proof.token_hash || !Object.hasOwn(PROVIDERS, data.provider)) return failure(env);
    try {
      const done = await commitCredentialChange(env, flow, proof, {
        sql: 'NOT EXISTS (SELECT 1 FROM oauth_identities WHERE (provider = ? AND subject = ?) OR (user_id = ? AND provider = ?))',
        params: [data.provider, data.subject, user.id, data.provider],
      }, [{sql: `INSERT INTO oauth_identities (provider, subject, user_id, label, created_at) SELECT ?, ?, ?, ?, ? WHERE ${CHANGE_GATE}`,
        params: [data.provider, data.subject, user.id, data.label, Date.now()]}], 'oauth_connected', data.provider);
      if (!done) return failure(env, 'That provider account is already connected, or the request expired.', 409);
    } catch { return failure(env, 'That provider account could not be connected. Accounts are never merged automatically.', 409); }
    await notify(env, user.id, `${PROVIDERS[data.provider as Provider]} sign-in was connected to your account. Other browsers and apps were signed out.`);
    return issueSession(env, user.id, proof.auth_version + 1, proof.auth_strength, '/account/security', proof.security_unlocked_at);
  }
  if (match?.[2] === 'disconnect') {
    const provider = match[1] as Provider;
    const token = await makeFlow(env, 'oauth-disconnect', user.id, {}, 600, proof.auth_version);
    const flow = await readFlow(env, token, 'oauth-disconnect');
    if (!flow) return failure(env);
    const done = await commitCredentialChange(env, flow, proof, {
      sql: `EXISTS (SELECT 1 FROM oauth_identities WHERE user_id = ? AND provider = ?) AND
        (EXISTS (SELECT 1 FROM email_credentials WHERE user_id = ?) OR EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?)
        OR EXISTS (SELECT 1 FROM oauth_identities WHERE user_id = ? AND provider != ?))`,
      params: [user.id, provider, user.id, user.id, user.id, provider],
    }, [{sql: `DELETE FROM oauth_identities WHERE user_id = ? AND provider = ? AND ${CHANGE_GATE}`, params: [user.id, provider]}], 'oauth_disconnected', provider);
    if (!done) return failure(env, 'Connect another sign-in method before disconnecting this provider. Authenticator codes alone cannot sign you in.', 400);
    await notify(env, user.id, `${PROVIDERS[provider]} sign-in was disconnected. Other browsers and apps were signed out. You can also revoke Blockworked access in your provider account settings.`);
    return issueSession(env, user.id, proof.auth_version + 1, proof.auth_strength, '/account/security', proof.security_unlocked_at);
  }
  return failure(env, 'Not found', 404);
}

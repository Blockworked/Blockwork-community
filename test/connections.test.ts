import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { fixture, cookieOf } from './helpers/accounts.ts';
import { issueSession, securityProof, makeFlow, readFlow } from '../src/account-security.ts';
import { currentUser, hash } from '../src/auth.ts';

async function owner(f: ReturnType<typeof fixture>, id = 'local:owner', strength = 'primary', next = '/account/security') {
  f.sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES (?, 'Original Name', 1, lower(hex(randomblob(6))))").run(id);
  return cookieOf(await issueSession(f.env, id, 0, strength, next));
}
function mailMock(t: any) {
  const mail: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(String(url), 'https://api.smtp2go.com/v3/email/send');
    mail.push(JSON.parse(String(init.body)));
    return Response.json({data: {succeeded: 1, failed: 0}});
  });
  return mail;
}
const tokenFrom = (text: string, action = 'approve') => text.match(new RegExp('/' + action + '\\?token=([\\w-]+)'))![1];
const keypair = generateKeyPair('RS256');
async function oauthMock(t: any, f: ReturnType<typeof fixture>) {
  const key = await keypair;
  const jwk = {...await exportJWK(key.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig'};
  const state = {githubId: 777, nonce: '', claimedNonce: null as string | null, aud: 'google-client', sub: 'google-subject', infoSub: 'google-subject', verifier: '', mails: [] as any[]};
  Object.assign(f.env, {GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret', GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret'});
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    switch (String(url)) {
      case 'https://github.com/login/oauth/access_token': state.verifier = JSON.parse(String(init!.body)).code_verifier; return Response.json({access_token: 'test-access'});
      case 'https://api.github.com/user': return Response.json({id: state.githubId, login: 'provider-name', name: 'Provider Name', email: 'do-not-auto-link@example.com'});
      case 'https://oauth2.googleapis.com/token': {
        const jwt = await new SignJWT({nonce: state.claimedNonce ?? state.nonce}).setProtectedHeader({alg: 'RS256', kid: 'test-key'}).setSubject(state.sub)
          .setIssuer('https://accounts.google.com').setAudience(state.aud).setIssuedAt().setExpirationTime('5m').sign(key.privateKey);
        return Response.json({access_token: 'test-google-access', id_token: jwt});
      }
      case 'https://www.googleapis.com/oauth2/v3/certs': return Response.json({keys: [jwk]});
      case 'https://openidconnect.googleapis.com/v1/userinfo': return Response.json({sub: state.infoSub, name: 'Google Name'});
      case 'https://api.smtp2go.com/v3/email/send': state.mails.push(JSON.parse(String(init!.body))); return Response.json({data: {succeeded: 1, failed: 0}});
      default: throw new Error('Unexpected outbound request: ' + String(url));
    }
  });
  return state;
}
const authorizationOf = async (response: Response) => response.headers.get('Location') ?? (await response.clone().json()).authorization;
async function returnFromProvider(f: ReturnType<typeof fixture>, start: Response, provider: 'github' | 'google', session = '') {
  const url = new URL(await authorizationOf(start));
  const stateCookie = cookieOf(start, '__Host-oauth-state');
  return f.request(`/auth/${provider}/callback?code=test-code&state=${url.searchParams.get('state')}`, undefined, [session, stateCookie].filter(Boolean).join('; '));
}

test('legacy OAuth IDs are backfilled without changing ownership or admin IDs', () => {
  const f = fixture(sql => {
    sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES ('github:123','Original',1,'original')").run();
  });
  const row = f.sql.prepare('SELECT * FROM oauth_identities').get()!;
  f.sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES ('google:rolling-user','During deploy',1,'rolling')").run();
  assert.equal(f.sql.prepare("SELECT user_id FROM oauth_identities WHERE provider='google'").get()!.user_id, 'google:rolling-user');
  assert.equal(row.provider, 'github'); assert.equal(row.subject, '123'); assert.equal(row.user_id, 'github:123');
});

test('an unlocked settings session survives five minutes, with idle, absolute and per-browser limits', async () => {
  const f = fixture(), session = await owner(f);
  const user = (await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env))!;
  f.sql.prepare('UPDATE sessions SET created_at = ?, security_unlocked_at = ?, security_last_used_at = ?').run(Date.now() - 1200000, Date.now() - 1200000, Date.now() - 1200000);
  assert.ok(await securityProof(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env, user));
  const other = cookieOf(await issueSession(f.env, user.id, 0, 'primary', '/'));
  assert.equal(await securityProof(new Request(f.env.SITE_URL, {headers: {Cookie: other}}), f.env, user), false);
  f.sql.prepare('UPDATE sessions SET security_last_used_at = ?').run(Date.now() - 1800001);
  assert.equal((await f.request('/account/security', undefined, session)).headers.get('Location'), '/account/unlock');
  f.sql.prepare('UPDATE sessions SET security_last_used_at = ?, security_unlocked_at = ?').run(Date.now(), Date.now() - 3600001);
  assert.equal(await securityProof(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env, user), false);
});

test('settings unlock requires a fresh credential proof, same account and browser intent', async () => {
  const f = fixture(), session = await owner(f, 'local:owner', 'primary', '/');
  f.sql.prepare("INSERT INTO email_credentials VALUES ('local:owner','owner@example.com','placeholder')").run();
  const page = await f.request('/account/unlock', undefined, session);
  const cookie = cookieOf(page, '__Host-settings-reauth');
  const flow = await readFlow(f.env, cookie.split('=')[1], 'settings-unlock');
  assert.ok(flow);
  const token = cookie.split('=')[1];
  const next = '/account/unlock/complete?token=' + token;
  assert.equal((await f.request(next, undefined, session + '; ' + cookie)).status, 403);
  f.sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES ('local:other','Other',0,'other')").run();
  assert.equal((await issueSession(f.env, 'local:other', 0, 'primary', next)).status, 403);
  const fresh = cookieOf(await issueSession(f.env, 'local:owner', 0, 'primary', next));
  assert.equal((await f.request(next, undefined, fresh)).status, 400);
  const opened = await f.request(next, undefined, fresh + '; ' + cookie);
  assert.equal(opened.status, 303);
  assert.equal(await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env), null);
  assert.equal((await f.request('/account/security', undefined, fresh)).status, 200);
  assert.equal((await f.request(next, undefined, fresh + '; ' + cookie)).status, 400);
  assert.equal((await f.request('/account/lock', {}, fresh)).status, 303);
  assert.equal((await f.request('/account/security', undefined, fresh)).headers.get('Location'), '/account/unlock');
});

test('email changes confirm both addresses without scanner activation, preserve MFA and revoke other access', async t => {
  const f = fixture(), mail = mailMock(t), session = await owner(f, 'local:owner', 'strong');
  f.sql.prepare("INSERT INTO email_credentials VALUES ('local:owner','old@example.com','same-password-hash')").run();
  f.sql.prepare("INSERT INTO passkeys VALUES ('owner-key','local:owner','00',0,'[]','Key',0)").run();
  f.sql.prepare("INSERT INTO backup_codes VALUES ('code','local:owner')").run();
  const staleReset = await makeFlow(f.env, 'reset', 'local:owner', {});
  assert.equal((await f.request('/account/email-change/start', {email: 'NEW@example.com'}, session)).status, 200);
  assert.equal(mail.length, 2);
  assert.equal(mail[0].to[0], 'old@example.com'); assert.equal(mail[1].to[0], 'new@example.com');
  const oldToken = tokenFrom(mail[0].text_body), newToken = tokenFrom(mail[1].text_body);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM email_changes').get()).includes(oldToken));
  assert.equal((await f.request('/account/email-change/approve?token=' + oldToken)).status, 200);
  assert.equal(f.sql.prepare('SELECT old_confirmed FROM email_changes').get()!.old_confirmed, 0);
  assert.equal((await f.request('/account/email-change/finish', {}, session)).status, 400);
  assert.equal((await f.request('/account/email-change/approve', {token: oldToken})).status, 200);
  assert.equal((await f.request('/account/email-change/approve', {token: oldToken})).status, 400);
  assert.equal((await f.request('/account/email-change/finish', {}, session)).status, 400);
  assert.equal((await f.request('/account/email-change/approve', {token: newToken})).status, 200);
  assert.equal((await f.request('/account/email-change/finish', {})).status, 401);
  const updated = await f.request('/account/email-change/finish', {}, session);
  assert.equal(updated.status, 303, await updated.clone().text());
  const row = f.sql.prepare('SELECT * FROM email_credentials').get()!;
  assert.equal(row.email, 'new@example.com'); assert.equal(row.password_hash, 'same-password-hash');
  assert.equal(await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env), null);
  assert.equal(await readFlow(f.env, staleReset, 'reset'), null);
  assert.ok(cookieOf(updated));
  assert.equal((await f.request('/account/security', undefined, cookieOf(updated))).status, 200);
  for (const table of ['passkeys','backup_codes']) assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 1);
  assert.equal(mail.length, 4); assert.equal(mail[2].to[0], 'old@example.com'); assert.equal(mail[3].to[0], 'new@example.com');
  assert.equal((await f.request('/account/email-change/finish', {}, cookieOf(updated))).status, 400);
});

test('old mailbox can cancel, old links expire, and revoked settings cannot change email', async t => {
  const f = fixture(), mail = mailMock(t), session = await owner(f);
  f.sql.prepare("INSERT INTO email_credentials VALUES ('local:owner','old@example.com','hash')").run();
  await f.request('/account/email-change/start', {email: 'new@example.com'}, session);
  const cancel = tokenFrom(mail[0].text_body, 'cancel');
  assert.equal((await f.request('/account/email-change/cancel?token=' + cancel)).status, 200);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM email_changes').get()!.n, 1);
  assert.equal((await f.request('/account/email-change/cancel', {token: cancel})).status, 200);
  assert.equal((await f.request('/account/email-change/approve', {token: tokenFrom(mail[1].text_body)})).status, 400);
  await f.request('/account/email-change/start', {email: 'new@example.com'}, session);
  f.sql.prepare('UPDATE email_changes SET expires_at = 0').run();
  assert.equal((await f.request('/account/email-change/approve', {token: tokenFrom(mail[2].text_body)})).status, 400);
  f.sql.prepare('UPDATE sessions SET security_last_used_at = 0').run();
  assert.equal((await f.request('/account/email-change/start', {email: 'new@example.com'}, session)).status, 401);
  assert.equal(f.sql.prepare('SELECT email FROM email_credentials').get()!.email, 'old@example.com');
});

test('OAuth connection is explicit, uses PKCE and browser-bound state, preserves ownership and cannot replay', async t => {
  const f = fixture(), session = await owner(f), provider = await oauthMock(t, f);
  const start = await f.request('/account/oauth/github/connect', {}, session);
  const auth = new URL(await authorizationOf(start));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM oauth_identities').get()!.n, 0);
  assert.equal((await f.request('/auth/github/callback?code=test&state=' + auth.searchParams.get('state'), undefined, session)).status, 400);
  const returned = await returnFromProvider(f, start, 'github', session);
  assert.equal(returned.status, 200);
  const {challengeOf} = await import('../src/api.ts');
  assert.equal(await challengeOf(provider.verifier), auth.searchParams.get('code_challenge'));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM oauth_identities').get()!.n, 0);
  const token = (await returned.text()).match(/name="token" value="([\w-]+)"/)![1];
  const confirm = await f.request('/account/oauth/confirm', {token}, session);
  assert.equal(confirm.status, 303, await confirm.clone().text());
  assert.equal(f.sql.prepare('SELECT user_id FROM oauth_identities').get()!.user_id, 'local:owner');
  assert.equal(f.sql.prepare('SELECT name FROM users').get()!.name, 'Original Name');
  assert.equal((await returnFromProvider(f, start, 'github', cookieOf(confirm))).status, 400);
  assert.equal((await f.request('/account/oauth/confirm', {token}, cookieOf(confirm))).status, 400);
  const signIn = await f.request('/auth/github/login');
  const signed = await returnFromProvider(f, signIn, 'github');
  const user = await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: cookieOf(signed)}}), f.env);
  assert.equal(user?.id, 'local:owner');
});

test('provider ownership collisions and account switching during linking cannot merge accounts', async t => {
  const f = fixture(), session = await owner(f), provider = await oauthMock(t, f);
  f.sql.prepare("INSERT INTO users (id,name,created_at,public_id) VALUES ('local:other','Other',0,'other')").run();
  f.sql.prepare("INSERT INTO oauth_identities VALUES ('github','777','local:other','Other',0)").run();
  const start = await f.request('/account/oauth/github/connect', {}, session);
  const returned = await returnFromProvider(f, start, 'github', session);
  const token = (await returned.text()).match(/name="token" value="([\w-]+)"/)![1];
  assert.equal((await f.request('/account/oauth/confirm', {token}, session)).status, 409);
  assert.equal(f.sql.prepare('SELECT user_id FROM oauth_identities').get()!.user_id, 'local:other');
  const otherCookie = cookieOf(await issueSession(f.env, 'local:other', 0, 'primary'));
  assert.equal((await f.request('/account/oauth/confirm', {token}, otherCookie)).status, 400);
  assert.equal(provider.mails.length, 0);
});

test('disconnect cannot remove the last sign-in or count TOTP as a standalone login', async t => {
  const f = fixture(), session = await owner(f, 'github:777', 'strong');
  await oauthMock(t, f);
  f.sql.prepare("INSERT OR IGNORE INTO oauth_identities VALUES ('github','777','github:777','Original',0)").run();
  f.sql.prepare("INSERT INTO totp_credentials VALUES ('github:777','ciphertext',0,0)").run();
  assert.equal((await f.request('/account/oauth/github/disconnect', {}, session)).status, 400);
  f.sql.prepare("INSERT INTO oauth_identities VALUES ('google','backup','github:777','Backup',0)").run();
  const disconnected = await f.request('/account/oauth/github/disconnect', {}, session);
  assert.equal(disconnected.status, 303, await disconnected.clone().text());
  assert.equal(f.sql.prepare("SELECT count(*) n FROM oauth_identities WHERE provider='github'").get()!.n, 0);
  const start = await f.request('/auth/github/login');
  const signed = await returnFromProvider(f, start, 'github');
  assert.equal(signed.status, 303);
  const newUser = await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: cookieOf(signed)}}), f.env);
  assert.ok(newUser); assert.notEqual(newUser.id, 'github:777');
  assert.equal(f.sql.prepare("SELECT name FROM users WHERE id='github:777'").get()!.name, 'Original Name');
});

test('Google sign-in validates the signed ID token, nonce, client audience and userinfo subject', async t => {
  const f = fixture(), provider = await oauthMock(t, f);
  for (const bad of ['nonce','audience','subject','valid']) {
    provider.claimedNonce = bad === 'nonce' ? 'wrong-nonce' : null;
    provider.aud = bad === 'audience' ? 'other-client' : 'google-client';
    provider.infoSub = bad === 'subject' ? 'other-subject' : provider.sub;
    const start = await f.request('/auth/google/login');
    provider.nonce = new URL(await authorizationOf(start)).searchParams.get('nonce')!;
    const signed = await returnFromProvider(f, start, 'google');
    assert.equal(signed.status, bad === 'valid' ? 303 : 401, bad + ': ' + await signed.clone().text());
  }
});

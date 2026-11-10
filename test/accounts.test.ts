import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, cookieOf, authenticator } from './helpers/accounts.ts';
import { currentUser, hash } from '../src/auth.ts';
import { makeFlow, readFlow, limit, passwordHash, passwordMatches, passwordError, newPasswordError, issueSession, finishPrimary, replacePassword } from '../src/account-security.ts';
import { accountMail } from '../src/account-mail.ts';

const password = 'a long unique test password 673!';
function mockMail(t: any) {
  const messages: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (String(url).startsWith('https://api.pwnedpasswords.com/range/')) return new Response('0'.repeat(35) + ':0');
    assert.equal(url, 'https://api.smtp2go.com/v3/email/send');
    messages.push(JSON.parse(String(options?.body)));
    return Response.json({data: {succeeded: 1, failed: 0}});
  });
  return messages;
}
async function userSession(f: ReturnType<typeof fixture>, id = 'local:test', strength = 'primary') {
  f.sql.prepare("INSERT OR IGNORE INTO users (id, name, created_at, public_id) VALUES (?, 'Test User', 1, 'public')").run(id);
  return cookieOf(await issueSession(f.env, id, 0, strength));
}

test('password hashing uses independent salts and verifies exact Unicode passwords', async () => {
  const encoded = await passwordHash(password);
  assert.notEqual(encoded, await passwordHash(password));
  assert.ok(await passwordMatches(password, encoded));
  assert.equal(await passwordMatches(password + '!', encoded), false);
  assert.equal(await passwordMatches(password, 'scrypt:1:1:1:salt:' + '0'.repeat(64)), false);
  assert.ok(passwordError('short'));
  assert.equal(passwordError('🙂'.repeat(15)), null);
  assert.ok(passwordError('🙂'.repeat(129)));
});

test('password breach screening uses padded range queries and fails closed', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.match(String(url), /^https:\/\/api.pwnedpasswords.com\/range\/[A-F0-9]{5}$/);
    assert.equal((options.headers as any)['Add-Padding'], 'true');
    return new Response('Unavailable', {status: 503});
  });
  assert.match((await newPasswordError(password))!, /temporarily unavailable/);
});

test('verification requires mailbox possession; GET does not consume; POST cannot replay', async t => {
  const mail = mockMail(t), f = fixture();
  const start = await f.request('/auth/email/signup', {email: ' User@Example.com ', name: 'My Name'});
  assert.equal(start.status, 200);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM users').get()!.n, 0);
  const token = mail[0].text_body.match(/token=([\w-]+)/)[1];
  const pending = f.sql.prepare('SELECT * FROM auth_flows').get()!;
  assert.equal(pending.token_hash, await hash(token));
  assert.ok(!JSON.stringify(pending).includes(token));
  assert.equal((await f.request('/auth/email/verify?token=' + token)).status, 200);
  assert.equal((await f.request('/auth/email/verify?token=' + token)).status, 200);
  assert.equal((await f.request('/auth/email/verify', {token, password})).status, 200);
  const row = f.sql.prepare('SELECT * FROM email_credentials').get()!;
  assert.equal(row.email, 'user@example.com');
  assert.ok(!String(row.password_hash).includes(password));
  assert.equal((await f.request('/auth/email/verify', {token, password})).status, 400);
  const login = await f.request('/auth/email/login', {email: 'user@example.com', password, next: '//attacker.example'});
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('Location'), '/');
  assert.ok(cookieOf(login));
  assert.match(login.headers.getSetCookie().join('\n'), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await f.request('/auth/email/login', {email: 'user@example.com', password: 'incorrect'})).status, 401);
});

test('cross-origin mutations and oversized bodies are refused before hashing', async () => {
  const f = fixture();
  assert.equal((await f.request('/auth/email/login', {email: 'a@example.com', password}, '', 'https://support.example.com')).status, 403);
  assert.equal((await f.request('/auth/email/login', {email: 'a@example.com', password: 'x'.repeat(21000)})).status, 413);
  f.env.LOCAL_AUTH_ENABLED = 'false';
  assert.equal((await f.request('/auth/email/signup')).status, 503);
});

test('one-time flow consumption and rate limits are atomic and expired/revoked proofs fail', async () => {
  const f = fixture();
  await userSession(f);
  const token = await makeFlow(f.env, 'test', 'local:test', {});
  const attempts = await Promise.all([readFlow(f.env, token, 'test', true), readFlow(f.env, token, 'test', true)]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const expired = await makeFlow(f.env, 'test', null, {}, -1);
  assert.equal(await readFlow(f.env, expired, 'test'), null);
  const revoked = await makeFlow(f.env, 'test', 'local:test', {});
  f.sql.prepare('UPDATE users SET auth_version = 1').run();
  assert.equal(await readFlow(f.env, revoked, 'test'), null);
  const limits = await Promise.all(Array.from({length: 12}, () => limit(f.env, 'test', 'person', 3)));
  assert.equal(limits.filter(Boolean).length, 3);
});

test('reset atomically invalidates browsers, apps and pending proofs while retaining MFA', async () => {
  const f = fixture();
  const session = await userSession(f);
  f.sql.prepare('INSERT INTO email_credentials VALUES (?, ?, ?)').run('local:test', 'user@example.com', 'old');
  f.sql.prepare("INSERT INTO passkeys VALUES ('key', 'local:test', '00', 0, '[]', 'Key', 0)").run();
  f.sql.prepare("INSERT INTO backup_codes VALUES ('backup', 'local:test')").run();
  f.sql.prepare("INSERT INTO app_codes (code_hash, user_id, challenge, expires_at) VALUES ('appcode', 'local:test', 'challenge', ?)").run(Date.now() + 10000);
  const reset = await makeFlow(f.env, 'reset', 'local:test', {});
  const second = await makeFlow(f.env, 'second-factor', 'local:test', {});
  const flow = (await readFlow(f.env, reset, 'reset'))!;
  assert.ok(await replacePassword(f.env, flow, 'new'));
  assert.equal(await replacePassword(f.env, flow, 'attacker'), false);
  assert.equal(f.sql.prepare('SELECT password_hash FROM email_credentials').get()!.password_hash, 'new');
  assert.equal(await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env), null);
  for (const table of ['sessions', 'app_codes', 'auth_flows']) assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  for (const table of ['passkeys', 'backup_codes']) assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 1);
  assert.equal(await readFlow(f.env, second, 'second-factor'), null);
  assert.equal((await finishPrimary(f.env, 'local:test', 0, '/account')).status, 401);
  const fresh = await finishPrimary(f.env, 'local:test', 1, '/account');
  assert.equal(fresh.headers.get('Location'), '/auth/second-factor');
  assert.equal(cookieOf(fresh), '');
});

test('real passkey registration, signed authentication, MFA and backup recovery', async t => {
  mockMail(t);
  const f = fixture(), key = authenticator();
  const session = await userSession(f);
  const options = await f.request('/auth/passkey/register-options', {label: '<My key>'}, session);
  const challenge = (await options.json()).challenge;
  const keyFlow = cookieOf(options, '__Host-passkey-flow');
  const registration = key.registration(challenge);
  const enrolled = await f.request('/auth/passkey/register-verify', registration, session + '; ' + keyFlow);
  assert.equal(enrolled.status, 200, await enrolled.clone().text());
  assert.equal(f.sql.prepare('SELECT count(*) n FROM passkeys').get()!.n, 1);
  assert.equal((await f.request('/auth/passkey/register-verify', registration, cookieOf(enrolled) + '; ' + keyFlow)).status, 400);
  let strong = cookieOf(enrolled);
  assert.ok(strong);
  const codes = await f.request('/account/backup', {}, strong);
  assert.equal(codes.status, 200);
  const html = await codes.text();
  const backup = html.match(/[a-f0-9]{4}(?:-[a-f0-9]{4}){7}/)![0];
  assert.equal(f.sql.prepare('SELECT count(*) n FROM backup_codes').get()!.n, 10);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM backup_codes').all()).includes(backup.replace(/-/g, '')));
  const pending = await finishPrimary(f.env, 'local:test', 1, '/account');
  assert.equal(pending.headers.get('Location'), '/auth/second-factor');
  const pendingCookie = cookieOf(pending, '__Host-auth-flow');
  // Cancelling a passkey prompt must leave the backup-code flow available.
  const assertionOptions = await f.request('/auth/passkey/options', {}, pendingCookie);
  const both = pendingCookie + '; ' + cookieOf(assertionOptions, '__Host-passkey-flow');
  const recovered = await f.request('/auth/backup/verify', {code: backup}, both);
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.ok(cookieOf(recovered));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM backup_codes').get()!.n, 9);
  const again = await finishPrimary(f.env, 'local:test', 1, '/account');
  assert.equal((await f.request('/auth/backup/verify', {code: backup}, cookieOf(again, '__Host-auth-flow'))).status, 400);
  const options2 = await f.request('/auth/passkey/options', {});
  const assertion = key.assertion((await options2.json()).challenge);
  const authFlow = cookieOf(options2, '__Host-passkey-flow');
  const signed = await f.request('/auth/passkey/verify', assertion, authFlow);
  assert.equal(signed.status, 200, await signed.clone().text());
  assert.ok(cookieOf(signed));
  assert.equal((await f.request('/auth/passkey/verify', assertion, authFlow)).status, 400);
  const removeLast = await f.request('/account/passkey/delete', {id: key.id}, cookieOf(signed));
  assert.equal(removeLast.status, 400);
});

test('passkeys reject the wrong origin, missing device verification and changed signatures', async () => {
  const f = fixture(), key = authenticator();
  const session = await userSession(f);
  for (const [origin, uv] of [['https://attacker.example', true], [f.env.SITE_URL, false]] as const) {
    const options = await f.request('/auth/passkey/register-options', {}, session);
    const response = key.registration((await options.json()).challenge, origin, uv);
    assert.equal((await f.request('/auth/passkey/register-verify', response, session + '; ' + cookieOf(options, '__Host-passkey-flow'))).status, 400);
  }
  const options = await f.request('/auth/passkey/register-options', {}, session);
  const enrolled = await f.request('/auth/passkey/register-verify', key.registration((await options.json()).challenge), session + '; ' + cookieOf(options, '__Host-passkey-flow'));
  assert.equal(enrolled.status, 200);
  for (const [origin, uv] of [['https://attacker.example', true], [f.env.SITE_URL, false], [f.env.SITE_URL, true]] as const) {
    const ask = await f.request('/auth/passkey/options', {});
    const response = key.assertion((await ask.json()).challenge, origin, uv);
    if (origin === f.env.SITE_URL && uv) response.response.signature = response.response.signature.slice(0, -4) + 'AAAA';
    assert.equal((await f.request('/auth/passkey/verify', response, cookieOf(ask, '__Host-passkey-flow'))).status, 400);
  }
});

test('security settings require an active unlock, and credential linking requires the requesting owner', async t => {
  const mail = mockMail(t), f = fixture();
  const session = await userSession(f, 'github:123');
  assert.equal((await f.request('/account/email', {email: 'linked@example.com'}, session)).status, 200);
  const token = mail[0].text_body.match(/token=([\w-]+)/)[1];
  assert.equal((await f.request('/auth/email/verify', {token, password})).status, 401);
  const other = await userSession(f, 'github:456');
  assert.equal((await f.request('/auth/email/verify', {token, password}, other)).status, 401);
  assert.equal((await f.request('/auth/email/verify', {token, password}, session)).status, 200);
  assert.equal(f.sql.prepare('SELECT user_id FROM email_credentials').get()!.user_id, 'github:123');
  f.sql.prepare('UPDATE sessions SET security_last_used_at = 0').run();
  assert.equal((await f.request('/account/password', {password}, session)).status, 401);
  assert.equal((await f.request('/account/revoke', {}, session)).status, 401);
});

test('authentication mail never logs tokens or falls back to development logging', async t => {
  const f = fixture();
  const logs = t.mock.method(console, 'log');
  f.env.SMTP2GO_API_KEY = undefined;
  assert.equal(await accountMail(f.env, 'private@example.com', 'reset', 'secret-token'), false);
  assert.equal(logs.mock.callCount(), 0);
});

test('TOTP encryption is randomized, authenticated and bound to the account', async () => {
  const {sealSecret, openSecret, acceptedStep, totp} = await import('../src/totp.ts');
  const f = fixture();
  const secret = 'JBSWY3DPEHPK3PXP';
  const sealed = await sealSecret(f.env, 'user1', secret);
  assert.notEqual(sealed, await sealSecret(f.env, 'user1', secret));
  assert.ok(!sealed.includes(secret));
  assert.equal(await openSecret(f.env, 'user1', sealed), secret);
  await assert.rejects(openSecret(f.env, 'user2', sealed));
  const differentKey = {...f.env, AUTH_TOTP_KEY: 'B'.repeat(43)};
  await assert.rejects(openSecret(differentKey, 'user1', sealed));
  await assert.rejects(openSecret(f.env, 'user1', sealed.slice(0, -2) + (sealed.endsWith('00') ? '01' : '00')));
  const now = 1234567890000;
  const code = totp(secret).generate({timestamp: now});
  assert.equal(acceptedStep(secret, code, now), Math.floor(now / 30000));
  assert.equal(acceptedStep(secret, code, now + 120000), null);
  assert.equal(acceptedStep(secret, '12345', now), null);
});

test('TOTP enrollment requires confirmation; password login accepts fresh codes once, retaining MFA after reset', async t => {
  mockMail(t);
  const {totp} = await import('../src/totp.ts');
  const f = fixture();
  const session = await userSession(f);
  const setup = await f.request('/account/totp/setup', {}, session);
  assert.equal(setup.status, 200);
  const html = await setup.text();
  assert.ok(html.includes('<svg'));
  const secret = html.match(/<pre>([A-Z2-7]+)<\/pre>/)![1];
  const flow = cookieOf(setup, '__Host-totp-enroll');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM totp_credentials').get()!.n, 0);
  assert.ok(!JSON.stringify(f.sql.prepare("SELECT data FROM auth_flows WHERE purpose = 'totp-enroll'").get()).includes(secret));
  const code = totp(secret).generate();
  const confirmed = await f.request('/account/totp/confirm', {code}, session + '; ' + flow);
  assert.equal(confirmed.status, 303, await confirmed.clone().text());
  assert.ok(cookieOf(confirmed));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM totp_credentials').get()!.n, 1);
  assert.equal((await f.request('/account/totp/confirm', {code}, cookieOf(confirmed) + '; ' + flow)).status, 400);
  assert.equal((await f.request('/account/totp/delete', {}, cookieOf(confirmed))).status, 400);
  const pending = await finishPrimary(f.env, 'local:test', 1, '/account');
  assert.equal(pending.headers.get('Location'), '/auth/second-factor');
  const pendingCookie = cookieOf(pending, '__Host-auth-flow');
  // The enrollment code cannot immediately be reused to sign in.
  assert.equal((await f.request('/auth/totp/verify', {code}, pendingCookie)).status, 400);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 30000);
  const nextCode = totp(secret).generate();
  const verified = await f.request('/auth/totp/verify', {code: nextCode}, pendingCookie);
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.ok(cookieOf(verified));
  assert.equal((await f.request('/auth/totp/verify', {code: nextCode}, pendingCookie)).status, 400);
  const another = await finishPrimary(f.env, 'local:test', 1, '/account');
  assert.equal((await f.request('/auth/totp/verify', {code: nextCode}, cookieOf(another, '__Host-auth-flow'))).status, 400);
  const backup = await f.request('/account/backup', {}, cookieOf(verified));
  assert.equal(backup.status, 200);
  f.sql.prepare('INSERT INTO email_credentials VALUES (?, ?, ?)').run('local:test', 'totp@example.com', 'old');
  const reset = await makeFlow(f.env, 'reset', 'local:test', {});
  assert.ok(await replacePassword(f.env, (await readFlow(f.env, reset, 'reset'))!, 'new'));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM totp_credentials').get()!.n, 1);
  assert.equal((await finishPrimary(f.env, 'local:test', 2, '/account')).headers.get('Location'), '/auth/second-factor');
});

test('support recovery is staff-only, MFA-gated, owner-directed and audited without impersonation', async t => {
  const mail = mockMail(t), f = fixture();
  const owner = await userSession(f);
  f.sql.prepare('INSERT INTO email_credentials VALUES (?, ?, ?)').run('local:test', 'owner@example.com', 'unchanged');
  f.sql.prepare("INSERT INTO passkeys VALUES ('owner-key', 'local:test', '00', 0, '[]', 'Key', 0)").run();
  f.sql.prepare("INSERT INTO backup_codes VALUES ('backup', 'local:test')").run();
  f.sql.prepare("INSERT INTO totp_credentials VALUES ('local:test', 'ciphertext', 0, 0)").run();
  f.sql.prepare("INSERT INTO tickets (subject, email, user_id, access_key, created_at, updated_at) VALUES ('Lost password', 'owner@example.com', 'local:test', 'private-ticket-key', 0, 0)").run();
  // Helpers use distinct public IDs because users_by_public_id is unique.
  f.sql.prepare("INSERT INTO users (id, name, created_at, public_id) VALUES ('github:staff', 'Staff', 0, 'staff')").run();
  const staffPrimary = cookieOf(await issueSession(f.env, 'github:staff', 0, 'primary'));
  const staffStrong = cookieOf(await issueSession(f.env, 'github:staff', 0, 'strong'));
  f.env.SUPPORT_STAFF = 'github:staff';
  assert.equal((await f.request('/staff/accounts', undefined, owner)).status, 404);
  assert.equal((await f.request('/staff/accounts', undefined, staffPrimary)).status, 403);
  const request = {ticket: '1', lookup: 'owner@example.com', reason: 'User requested password recovery in ticket'};
  const lookup = await f.request('/staff/accounts/lookup', request, staffStrong);
  assert.equal(lookup.status, 200, await lookup.clone().text());
  const html = await lookup.text();
  assert.ok(html.includes('o***@example.com'));
  for (const secret of ['owner@example.com', 'owner-key', 'private-ticket-key', 'ciphertext', 'unchanged']) assert.ok(!html.includes(secret));
  assert.equal((await f.request('/staff/accounts/reset', request, staffStrong)).status, 200);
  assert.equal(mail[0].to[0], 'owner@example.com');
  const token = mail[0].text_body.match(/token=([\w-]+)/)[1];
  assert.ok(token);
  assert.equal(cookieOf(await f.request('/staff/accounts/reset', request, staffStrong)), '');
  const revoked = await f.request('/staff/accounts/revoke', request, staffStrong);
  assert.equal(revoked.status, 200);
  assert.equal(cookieOf(revoked), '');
  assert.equal(await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: owner}}), f.env), null);
  assert.equal(f.sql.prepare('SELECT password_hash FROM email_credentials').get()!.password_hash, 'unchanged');
  for (const table of ['passkeys', 'totp_credentials', 'backup_codes']) assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM support_recovery_audit').get()!.n, 4);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM support_recovery_audit').all()).includes(token));
  assert.equal((await f.request('/staff/accounts/impersonate', request, staffStrong)).status, 404);
  assert.equal((await f.request('/staff/accounts/reset', {...request, ticket: '999'}, staffStrong)).status, 404);
});

test('a desktop code exchange already in progress cannot survive credential revocation', async () => {
  const {api, appLoginConfirm, challengeOf} = await import('../src/api.ts');
  const f = fixture();
  const session = await userSession(f);
  const user = (await currentUser(new Request(f.env.SITE_URL, {headers: {Cookie: session}}), f.env))!;
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const parameters = new URLSearchParams({port: '49152', state: 'abcdefghijklmnop', challenge: await challengeOf(verifier), label: 'Test desktop'});
  const consent = await appLoginConfirm(new Request(f.env.SITE_URL + '/app/login', {method: 'POST', headers: {Cookie: session}, body: parameters}), f.env, user);
  const code = new URL(consent.headers.get('Location')!).searchParams.get('code');
  assert.ok(code);
  const original = f.env.DB.prepare.bind(f.env.DB);
  let revoked = false;
  f.env.DB.prepare = ((query: string) => {
    // The authorization code has been atomically consumed by this point. This
    // models reset/revocation racing with the subsequent session issuance.
    if (query === 'SELECT id, name, avatar, banned FROM users WHERE id = ?' && !revoked) {
      revoked = true;
      f.sql.exec('UPDATE users SET auth_version = auth_version + 1; DELETE FROM sessions; DELETE FROM app_codes;');
    }
    return original(query);
  }) as typeof f.env.DB.prepare;
  const response = await api(new Request(f.env.SITE_URL + '/api/v1/app/token', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code, verifier})}), f.env, '/api/v1/app/token');
  assert.ok(revoked);
  assert.equal(response.status, 400);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM sessions').get()!.n, 0);
  assert.equal((await response.json()).token, undefined);
});

test('redirect destinations cannot turn control characters or backslashes into external URLs', async () => {
  const {safeNext} = await import('../src/auth.ts');
  for (const value of ['/\t/evil.example', '/\n/evil.example', '/\\evil.example', '//evil.example', 'https://evil.example']) assert.equal(safeNext(value), '/');
  assert.equal(safeNext('/app/login?port=49152&state=abc'), '/app/login?port=49152&state=abc');
});

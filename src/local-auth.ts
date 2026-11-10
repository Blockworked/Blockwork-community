import type { Env } from './index.ts';
import { currentUser, hash, isReservedName, safeNext, PROVIDERS, type User } from './auth.ts';
import { esc } from './pages.ts';
import { accountPage as screen } from './account-views.ts';
import { totpRoute } from './totp.ts';
import { staffAccounts } from './staff-accounts.ts';
import { isEmail, normalizeEmail } from './support-mail.ts';
import { notify, sendAccountToken } from './account-mail.ts';
import { boundedBody, DUMMY_HASH, finishPrimary, flowToken, hex, limit, makeFlow, newPasswordError, passwordHash,
  passwordMatches, readFlow, securityProof, redirect, replacePassword, version, type Flow } from './account-security.ts';
import { passkeyRoute } from './passkeys.ts';
import { securityUnlock } from './security-unlock.ts';
import { emailChange } from './email-change.ts';
import { oauthSettings } from './oauth.ts';
import { ACCOUNT_JS } from './account-ui.ts';

const field = (body: Record<string, unknown>, name: string) => typeof body[name] === 'string' ? body[name] as string : '';
function input(name: string, label: string, type = 'text', autocomplete = name): string {
  return `<p><label>${esc(label)}<br><input name="${esc(name)}" type="${type}" autocomplete="${autocomplete}" required ${type === 'password' ? 'minlength="15" maxlength="128"' : 'maxlength="254"'}></label></p>`;
}


function error(env: Env, text = 'Verification expired or failed. Sign in and try again.', status = 400): Response {
  return screen(null, env, 'Account security', `<p role="alert">${esc(text)}</p><p><a href="${text.startsWith('Unlock') ? '/account/unlock' : '/login'}">${text.startsWith('Unlock') ? 'Unlock security settings' : 'Sign in'}</a></p>`, status);
}

function mailNotice(env: Env): Response {
  return screen(null, env, 'Check your email', '<p>If this address is eligible, an email with the next steps will arrive shortly.</p><p><a href="/login">Back to sign in</a></p>');
}

async function settings(req: Request, env: Env, user: User): Promise<Response> {
  const email = await env.DB.prepare('SELECT email FROM email_credentials WHERE user_id = ?').bind(user.id).first<{email: string}>();
  const keys = await env.DB.prepare('SELECT id, label FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(user.id).all<{id: string; label: string}>();
  const app = await env.DB.prepare('SELECT 1 FROM totp_credentials WHERE user_id = ?').bind(user.id).first();
  const codes = await env.DB.prepare('SELECT count(*) AS n FROM backup_codes WHERE user_id = ?').bind(user.id).first<{n: number}>();
  const sessions = await env.DB.prepare('SELECT kind, label, created_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50')
    .bind(user.id, Date.now()).all<{kind: string; label: string; created_at: number}>();
  const identities = await env.DB.prepare('SELECT provider, label FROM oauth_identities WHERE user_id = ?').bind(user.id).all<{provider: keyof typeof PROVIDERS; label: string}>();
  const activity = await env.DB.prepare('SELECT action,detail,created_at FROM account_security_events WHERE user_id = ? ORDER BY id DESC LIMIT 10').bind(user.id).all<{action: string; detail: string; created_at: number}>();
  const pending = await env.DB.prepare('SELECT new_email,old_confirmed,new_confirmed FROM email_changes WHERE user_id = ? AND expires_at > ? AND auth_version = (SELECT auth_version FROM users WHERE id = ?)').bind(user.id, Date.now(), user.id).first<{new_email: string; old_confirmed: number; new_confirmed: number}>();
  return screen(user, env, 'Account security', `
    <p>Security settings are unlocked for this browser. Settings lock after 30 minutes of inactivity or one hour total.</p><form method="post" action="/account/lock"><button>Lock security settings</button></form>
    <section class="card"><h2>Email and password</h2>${email ? `<p>${esc(email.email)}</p><form method="post" action="/account/password">${input('password', 'New password', 'password', 'new-password')}<button>Change password</button></form>
      <h3>Change linked email</h3><form method="post" action="/account/email-change/start">${input('email', 'New email address', 'email')}<button>Request email change</button></form>
      <p>Confirm both your current and new email addresses, then finish here. Your current email works until the change is complete.</p>
      ${pending ? `<p>Pending: ${esc(pending.new_email)} · Current address: ${pending.old_confirmed ? 'confirmed' : 'waiting'} · New address: ${pending.new_confirmed ? 'confirmed' : 'waiting'}</p><form method="post" action="/account/email-change/finish"><button ${pending.old_confirmed && pending.new_confirmed ? '' : 'disabled'}>Finish email change</button></form>` : ''}` :
      `<p>Add verified email credentials to this account. This preserves your packs and support tickets.</p><form method="post" action="/account/email">${input('email', 'Email', 'email')}<button>Verify email</button></form>`}
    <p>Use a unique password with at least 15 characters. Password managers and pasting are supported.</p></section>
    <section class="card"><h2>Connected sign-in accounts</h2>
    ${Object.entries(PROVIDERS).map(([provider, name]) => {
      const connected = identities.results.find(i => i.provider === provider);
      return `<p>${esc(name)}: ${connected ? esc(connected.label) : 'Not connected'}</p><form ${connected ? '' : 'data-oauth-connect'} method="post" action="/account/oauth/${provider}/${connected ? 'disconnect' : 'connect'}"><button>${connected ? 'Disconnect' : 'Connect'} ${esc(name)}</button></form>`;
    }).join('')}
    <p>Connections belong to this account. Connecting or disconnecting signs out other browsers and apps. Keep at least one working sign-in method.</p>
    <p>To revoke the provider's permission to access your profile, also review connected apps in your Google or GitHub settings.</p></section>
    <section class="card"><h2>Passkeys</h2><p>Use a passkey to sign in directly, or as a second step after your password or Google/GitHub sign-in.</p>
    <ul>${keys.results.map(k => `<li>${esc(k.label)} <form class="inline" method="post" action="/account/passkey/delete"><input type="hidden" name="id" value="${esc(k.id)}"><button>Remove</button></form></li>`).join('') || '<li>No passkeys yet.</li>'}</ul>
    <p><label>Passkey name <input id="passkey-label" type="text" maxlength="80" value="My passkey"></label></p><button type="button" data-passkey="register">Add passkey</button>
    <p>Keep at least one passkey or authenticator app. Add a replacement before removing a lost device.</p></section>
    <section class="card"><h2>Authenticator app</h2><p>${app ? 'Enabled. Your app generates a new six-digit code every 30 seconds.' : 'Use six-digit codes from an authenticator app as a second sign-in step.'}</p>
    <form method="post" action="/account/totp/setup"><button>${app ? 'Replace authenticator app' : 'Set up authenticator app'}</button></form>
    ${app ? '<form method="post" action="/account/totp/delete"><button>Remove authenticator app</button></form>' : ''}</section>
    <section class="card"><h2>Backup codes</h2><p>${codes?.n ?? 0} unused codes. Save these somewhere safe, separate from your device. Each works once after your password or Google/GitHub sign-in.</p>
    <form method="post" action="/account/backup"><button ${keys.results.length || app ? '' : 'disabled'}>Generate new backup codes</button></form><p>Generating codes invalidates all previous codes.</p></section>
    <section class="card"><h2>Signed-in sessions</h2><ul>${sessions.results.map(s => `<li>${s.kind === 'app' ? 'App' : 'Browser'} ${esc(s.label)}${s.created_at ? ` — ${esc(new Date(s.created_at).toISOString().slice(0, 10))}` : ''}</li>`).join('')}</ul>
    <form method="post" action="/account/revoke"><button>Sign out all browsers and apps</button></form></section>
    <section class="card"><h2>Recent account changes</h2><ul>${activity.results.map(event => {
      const label = event.action === 'email_changed' ? 'Linked email changed' : event.action === 'oauth_connected' ? 'Sign-in connected' : 'Sign-in disconnected';
      return `<li>${esc(label)}${event.detail ? `: ${esc(PROVIDERS[event.detail as keyof typeof PROVIDERS] || event.detail)}` : ''} · ${esc(new Date(event.created_at).toISOString())}</li>`;
    }).join('') || '<li>No recent changes.</li>'}</ul></section>
    <p id="auth-status" role="status"></p><script src="/account.js" defer></script>`);
}

/** Local credentials are explicitly enabled after mail, migrations and CPU limits are configured. */
export async function localAuth(req: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname;
  if (!(path === '/account.js' || path === '/account' || path.startsWith('/account/') || path.startsWith('/auth/email/') || path.startsWith('/auth/passkey/') || path.startsWith('/auth/backup/') || path.startsWith('/auth/totp/') || path.startsWith('/staff/accounts') || path === '/auth/second-factor')) return null;
  if (env.LOCAL_AUTH_ENABLED !== 'true') return error(env, 'Email accounts and passkeys are not enabled yet.', 503);
  // Credential ceremonies only run on the canonical origin, never on a sibling helpdesk host.
  if (url.origin !== new URL(env.SITE_URL).origin) return new Response('Not found', {status: 404});
  if (req.method === 'GET' && path === '/account.js') return new Response(ACCOUNT_JS, {headers: {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300'}});
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, POST'}});
  if (req.method === 'POST' && req.headers.get('Origin') !== new URL(env.SITE_URL).origin) return error(env, 'Cross-site request refused.', 403);
  const user = await currentUser(req, env);
  if (path.startsWith('/staff/accounts')) return staffAccounts(req, env, user, ctx);
  if (path.startsWith('/account/unlock') || path === '/account/lock') return securityUnlock(req, env, user);
  if (req.method === 'GET' && path.startsWith('/account/email-change/')) return emailChange(req, env, user);
  if (req.method === 'GET') {
    if (path === '/account') {
      if (!user) return redirect('/login?next=%2Faccount');
      return await securityProof(req, env, user) ? settings(req, env, user) : redirect('/account/unlock');
    }
    if (path === '/auth/email/signup') return screen(user, env, 'Create an account', `<form method="post">${input('name', 'Display name', 'text', 'nickname')}${input('email', 'Email', 'email')}<button class="primary">Verify email</button></form><p>You will set a password after verifying your email.</p>`);
    if (path === '/auth/email/forgot') return screen(user, env, 'Reset password', `<form method="post">${input('email', 'Email', 'email')}<button>Send reset link</button></form><p>Resetting your password signs out all browsers and apps. Your passkeys, authenticator app and backup codes stay in place.</p>`);
    if (path === '/auth/email/verify' || path === '/auth/email/reset') {
      const purpose = path.endsWith('reset') ? 'reset' : 'verify';
      const token = url.searchParams.get('token') ?? '';
      const flow = await readFlow(env, token, purpose);
      if (!flow) return error(env);
      return screen(user, env, purpose === 'reset' ? 'Set a new password' : 'Verify email and set password', `<form method="post" action="${path}"><input type="hidden" name="token" value="${esc(token)}">${input('password', 'New password', 'password', 'new-password')}<button class="primary">Save password</button></form><p>Use a unique password with at least 15 characters.</p>`);
    }
    if (path === '/auth/second-factor') {
      const pending = await readFlow(env, flowToken(req), 'second-factor');
      if (!pending) return error(env);
      const hasKey = await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').bind(pending.user_id).first();
      const hasApp = await env.DB.prepare('SELECT 1 FROM totp_credentials WHERE user_id = ?').bind(pending.user_id).first();
      return screen(null, env, 'Verify your sign-in', `${hasKey ? '<button type="button" data-passkey="login">Use a passkey</button>' : ''}
        ${hasApp ? '<form id="totp-form"><p><label>Six-digit code <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label></p><button>Verify authenticator code</button></form>' : ''}
        <h2>Lost access to your second factor?</h2><form id="backup-form"><p><label>Backup code <input name="code" type="text" autocomplete="one-time-code" required maxlength="64"></label></p><button>Use backup code</button></form>
        <p>After signing in with a backup code, add a replacement passkey or authenticator app in Account security.</p><p id="auth-status" role="status"></p><script src="/account.js" defer></script>`);
    }
    return error(env, 'Not found', 404);
  }
  const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
  if (!await limit(env, 'auth-ip', ip, 40)) return error(env, 'Too many attempts. Try again in 15 minutes.', 429);
  let body: Record<string, unknown>;
  try { body = await boundedBody(req); } catch { return error(env, 'Invalid or oversized request.', 413); }
  if (path.startsWith('/account/email-change/')) return emailChange(req, env, user, body);
  if (path.startsWith('/account/oauth/')) return oauthSettings(req, env, user, path, body);
  if (path.startsWith('/account/totp/') || path === '/auth/totp/verify') return totpRoute(req, env, path, body, user);
  if (path.startsWith('/auth/passkey/') || path === '/auth/backup/verify') return passkeyRoute(req, env, path, body);
  const deliver = async (job: Promise<void>) => {
    if (ctx) ctx.waitUntil(job.catch(() => { console.error('Account email could not be queued'); }));
    else await job;
  };
  const email = normalizeEmail(field(body, 'email'));
  const password = field(body, 'password');
  if (path === '/auth/email/login') {
    if (!isEmail(email) || !password || new TextEncoder().encode(password).length > 512) return error(env, 'Email or password is incorrect.', 401);
    if (!await limit(env, 'password-email', email, 10)) return error(env, 'Too many attempts. Try again in 15 minutes.', 429);
    const row = await env.DB.prepare('SELECT e.*, u.auth_version, u.banned FROM email_credentials e JOIN users u ON u.id = e.user_id WHERE email = ?')
      .bind(email).first<{user_id: string; password_hash: string; auth_version: number; banned: number}>();
    const valid = await passwordMatches(password, row?.password_hash ?? DUMMY_HASH);
    if (!valid || !row || row.banned) return error(env, 'Email or password is incorrect.', 401);
    return finishPrimary(env, row.user_id, row.auth_version, safeNext(field(body, 'next') || '/account', env));
  }
  if (path === '/auth/email/signup' || path === '/auth/email/forgot' || path === '/account/email') {
    if (!env.SMTP2GO_API_KEY) return error(env, 'Account email is temporarily unavailable.', 503);
    if (!isEmail(email)) return error(env, 'Enter a valid email address.');
    if (!await limit(env, 'mail-email', email, 4, 3600) || !await limit(env, 'mail-ip', ip, 10, 3600)) return mailNotice(env);
    const known = await env.DB.prepare('SELECT user_id FROM email_credentials WHERE email = ?').bind(email).first<{user_id: string}>();
    if (path === '/auth/email/forgot') {
      if (known && await version(env, known.user_id) >= 0) await deliver(sendAccountToken(env, email, 'reset', known.user_id, {}, 'Reset your Blockworked password'));
    } else if (path === '/account/email') {
      if (!user || !await securityProof(req, env, user)) return error(env, 'Unlock Account security before adding email credentials.', 401);
      const attached = await env.DB.prepare('SELECT 1 FROM email_credentials WHERE user_id = ?').bind(user.id).first();
      if (!known && !attached) await deliver(sendAccountToken(env, email, 'verify', user.id, {email, link: true}, 'Verify your Blockworked email'));
    } else {
      const name = field(body, 'name').trim();
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || isReservedName(name)) return error(env, 'Choose a display name between 1 and 80 characters. Team names are reserved.');
      if (!known) await deliver(sendAccountToken(env, email, 'verify', null, {email, name}, 'Verify your Blockworked email'));
    }
    return mailNotice(env);
  }
  if (path === '/auth/email/verify' || path === '/auth/email/reset' || path === '/account/password') {
    if (!await limit(env, 'password-set-ip', ip, 8)) return error(env, 'Too many attempts. Try again in 15 minutes.', 429);
    let flow: Flow | null;
    if (path === '/account/password') {
      if (!user || !await securityProof(req, env, user)) return error(env, 'Unlock Account security before changing your password.', 401);
      const token = await makeFlow(env, 'password-change', user.id, {});
      if (!await securityProof(req, env, user)) return error(env);
      flow = await readFlow(env, token, 'password-change');
    } else flow = await readFlow(env, field(body, 'token'), path.endsWith('reset') ? 'reset' : 'verify');
    if (!flow) return error(env);
    const data = JSON.parse(flow.data);
    if (data.link && (!user || user.id !== flow.user_id || !await securityProof(req, env, user))) return error(env, 'Sign in to the account that requested this email address, then reopen the link.', 401);
    const invalid = await newPasswordError(password);
    if (invalid) return error(env, invalid);
    const encoded = await passwordHash(password);
    if (flow.purpose !== 'verify') {
      if (!await replacePassword(env, flow, encoded)) return error(env);
      await notify(env, flow.user_id!, 'Your Blockworked password changed. All browsers and apps have been signed out. Your passkeys, authenticator app and backup codes remain active.');
      return screen(null, env, 'Password updated', '<p>All browsers and apps have been signed out. Sign in with your new password and, if enrolled, a passkey, authenticator-app code or backup code.</p><p><a href="/login">Sign in</a></p>');
    }
    // GET/email scanners never consume links. Account creation and link consumption are atomic.
    const id = flow.user_id ?? `local:${crypto.randomUUID()}`;
    const guard = 'EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)';
    const now = Date.now();
    const statements = [];
    if (!data.link) statements.push(env.DB.prepare(`INSERT INTO users (id, name, created_at, public_id) SELECT ?, ?, ?, lower(hex(randomblob(6))) WHERE ${guard}`)
      .bind(id, data.name, now, flow.token_hash, now));
    statements.push(env.DB.prepare(`INSERT INTO email_credentials (user_id, email, password_hash) SELECT ?, ?, ? WHERE ${guard}`)
      .bind(id, data.email, encoded, flow.token_hash, now));
    statements.push(env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ?').bind(flow.token_hash));
    try {
      const results = await env.DB.batch(statements);
      if (results[0].meta.changes !== 1) return error(env);
    } catch { return error(env, 'This link can no longer be used. Try signing in or resetting your password.'); }
    // Verification does not automatically log in, avoiding MFA downgrade when linking credentials.
    return screen(null, env, 'Email verified', '<p>Your email and password are ready. You can now sign in.</p><p><a href="/login">Sign in</a></p>');
  }
  if (path.startsWith('/account/')) {
    if (!user || !await securityProof(req, env, user)) return error(env, 'Unlock Account security before changing security settings.', 401);
    const token = await makeFlow(env, 'security-change', user.id, {});
    if (!await securityProof(req, env, user)) return error(env);
    const flow = await readFlow(env, token, 'security-change');
    if (!flow) return error(env);
    const guard = 'EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)';
    const now = Date.now();
    if (path === '/account/backup') {
      if (!await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ? UNION ALL SELECT 1 FROM totp_credentials WHERE user_id = ? LIMIT 1').bind(user.id, user.id).first()) return error(env, 'Add a passkey or authenticator app first.');
      const codes = Array.from({length: 10}, () => hex(crypto.getRandomValues(new Uint8Array(16))));
      const results = await env.DB.batch([
        env.DB.prepare(`DELETE FROM backup_codes WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        ...await Promise.all(codes.map(async code => env.DB.prepare(`INSERT INTO backup_codes (code_hash, user_id) SELECT ?, ? WHERE ${guard}`).bind(await hash(code), user.id, flow.token_hash, now))),
        env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ?').bind(flow.token_hash),
      ]);
      if (results[1].meta.changes !== 1) return error(env);
      await notify(env, user.id, 'New Blockworked backup codes were generated. All previous backup codes are invalid.');
      return screen(user, env, 'Save your backup codes', `<p>These codes are shown once. Save them in a secure place. Each works once with your password or Google/GitHub sign-in.</p><pre>${codes.map(code => code.match(/.{4}/g)!.join('-')).join('\n')}</pre><p><a href="/account">I saved my codes</a></p>`);
    }
    if (path === '/account/passkey/delete') {
      const count = await env.DB.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id = ?').bind(user.id).first<{n: number}>();
      const hasApp = await env.DB.prepare('SELECT 1 FROM totp_credentials WHERE user_id = ?').bind(user.id).first();
      const primary = await env.DB.prepare('SELECT 1 FROM email_credentials WHERE user_id = ? UNION ALL SELECT 1 FROM oauth_identities WHERE user_id = ? LIMIT 1').bind(user.id, user.id).first();
      if (count?.n === 1 && !primary) return error(env, 'Add a password or provider sign-in before removing your last passkey.');
      if (!count || (count.n <= 1 && !hasApp)) return error(env, 'Add a replacement passkey or authenticator app before removing the last one.');
      const results = await env.DB.batch([
        env.DB.prepare(`DELETE FROM passkeys WHERE id = ? AND user_id = ? AND ((SELECT count(*) FROM passkeys WHERE user_id = ?) > 1 OR EXISTS (SELECT 1 FROM totp_credentials WHERE user_id = ?)) AND ((SELECT count(*) FROM passkeys WHERE user_id = ?) > 1 OR EXISTS (SELECT 1 FROM email_credentials WHERE user_id = ?) OR EXISTS (SELECT 1 FROM oauth_identities WHERE user_id = ?)) AND ${guard}`)
          .bind(field(body, 'id'), user.id, user.id, user.id, user.id, user.id, user.id, flow.token_hash, now),
        // The first statement must succeed; a second guard ties invalidation to the removed ID.
        env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${guard} AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?)`)
          .bind(user.id, flow.token_hash, now, field(body, 'id')),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      ]);
      if (results[0].meta.changes !== 1) return error(env);
      await notify(env, user.id, 'A passkey was removed from your Blockworked account. All browsers and apps have been signed out.');
      return redirect('/login?next=%2Faccount');
    }
    if (path === '/account/revoke') {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
        env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${guard}`).bind(user.id, flow.token_hash, now),
      ]);
      if (results[0].meta.changes !== 1) return error(env);
      return redirect('/login');
    }
  }
  return error(env, 'Not found', 404);
}

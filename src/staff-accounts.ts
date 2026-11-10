// Support can initiate owner-controlled recovery, never receive a login credential.
import type { Env } from './index.ts';
import { cookies, hash, type User } from './auth.ts';
import { isStaff } from './support.ts';
import { esc } from './pages.ts';
import { accountPage } from './account-views.ts';
import { SECURITY_IDLE_MS, SECURITY_MAX_MS, boundedBody, limit, makeFlow, readFlow, securityProof } from './account-security.ts';
import { notify, sendAccountToken } from './account-mail.ts';

interface Target { id: string; public_id: string; name: string; banned: number; email: string | null }
const value = (body: Record<string, unknown>, key: string) => typeof body[key] === 'string' ? body[key] as string : '';
export function maskedEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
}
function view(env: Env, user: User, html: string, status = 200): Response {
  return accountPage(user, env, 'Support account recovery', html, status);
}
export async function staffAccounts(req: Request, env: Env, user: User | null, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  if (!user || !isStaff(env, user)) return new Response('Not found', {status: 404});
  if (!await securityProof(req, env, user, true)) return view(env, user,
    '<p>Support recovery requires MFA and an unlocked security-settings session. Enroll MFA in Account security, then unlock settings to continue.</p><p><a href="/account">Account security</a> · <a href="/account/unlock?next=%2Fstaff%2Faccounts">Unlock settings</a></p>', 403);
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/staff/accounts') return view(env, user, `<p>Find an account in connection with a support ticket. Actions are audited. Recovery emails go only to the account's existing verified address.</p>
    <form method="post" action="/staff/accounts/lookup"><p><label>Ticket number <input type="text" inputmode="numeric" name="ticket" pattern="[0-9]+" required></label></p>
    <p><label>Account ID or verified email <input type="text" name="lookup" maxlength="254" required></label></p>
    <p><label>Reason <input type="text" name="reason" minlength="10" maxlength="500" required></label></p><button>Look up account</button></form>
    <p>These tools cannot sign in as a user, show reset links or backup codes, change email addresses, set passwords, or remove MFA.</p>`);
  if (req.method !== 'POST' || !['/staff/accounts/lookup', '/staff/accounts/reset', '/staff/accounts/revoke'].includes(path)) return new Response('Not found', {status: 404});
  if (!await limit(env, 'staff-actions', user.id, 30, 3600)) return view(env, user, '<p>Too many support recovery actions. Try again in an hour.</p>', 429);
  let body: Record<string, unknown>;
  try { body = await boundedBody(req); } catch { return view(env, user, '<p>Invalid request.</p>', 400); }
  const ticket = Number(value(body, 'ticket'));
  const lookup = value(body, 'lookup').trim();
  const reason = value(body, 'reason').trim();
  if (!Number.isSafeInteger(ticket) || ticket < 1 || !lookup || lookup.length > 254 || reason.length < 10 || reason.length > 500) return view(env, user, '<p>Provide an account, a ticket number, and a reason between 10 and 500 characters.</p>', 400);
  const target = await env.DB.prepare(`SELECT u.id, u.public_id, u.name, u.banned, e.email FROM users u LEFT JOIN email_credentials e ON e.user_id = u.id
    WHERE u.id = ? OR u.public_id = ? OR e.email = ? LIMIT 1`).bind(lookup, lookup, lookup.toLowerCase()).first<Target>();
  const linkedTicket = target && await env.DB.prepare('SELECT 1 FROM tickets WHERE id = ? AND (user_id = ? OR (? IS NOT NULL AND lower(email) = ?))')
    .bind(ticket, target.id, target.email, target.email).first();
  if (!target || !linkedTicket) return view(env, user, '<p>No account matching this ticket was found.</p>', 404);
  const action = path.endsWith('/reset') ? 'reset_email' : path.endsWith('/revoke') ? 'revoke' : 'lookup';
  if (action === 'revoke') {
    const token = await makeFlow(env, 'support-revoke', target.id, {});
    if (!await securityProof(req, env, user, true)) return view(env, user, '<p>Unlock security settings before continuing.</p>', 403);
    const flow = await readFlow(env, token, 'support-revoke');
    if (!flow) return view(env, user, '<p>Account changed. Look it up again.</p>', 409);
    const sessionHashes = await Promise.all(cookies(req, 'session').slice(0, 2).map(hash));
    const now = Date.now();
    const guard = 'EXISTS (SELECT 1 FROM auth_flows f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND f.expires_at > ? AND u.auth_version = ?)';
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?
        AND EXISTS (SELECT 1 FROM auth_flows WHERE token_hash = ? AND expires_at > ?)
        AND EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND token_hash IN (?, ?) AND kind = 'web' AND auth_strength IN ('strong', 'totp') AND security_unlocked_at > ? AND security_last_used_at > ? AND expires_at > ?)`)
        .bind(target.id, flow.auth_version, flow.token_hash, now, user.id, sessionHashes[0] ?? '', sessionHashes[1] ?? '', now - SECURITY_MAX_MS, now - SECURITY_IDLE_MS, now),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND ${guard}`).bind(target.id, flow.token_hash, now, flow.auth_version + 1),
      env.DB.prepare(`DELETE FROM app_codes WHERE user_id = ? AND ${guard}`).bind(target.id, flow.token_hash, now, flow.auth_version + 1),
      env.DB.prepare(`INSERT INTO support_recovery_audit (actor_id, target_id, action, ticket_id, reason, created_at) SELECT ?, ?, 'revoke', ?, ?, ? WHERE ${guard}`)
        .bind(user.id, target.id, ticket, reason, now, flow.token_hash, now, flow.auth_version + 1),
      env.DB.prepare(`DELETE FROM auth_flows WHERE user_id = ? AND ${guard}`).bind(target.id, flow.token_hash, now, flow.auth_version + 1),
    ]);
    if (results[0].meta.changes !== 1) return view(env, user, '<p>Account or staff session changed. Sign in and look up the account again.</p>', 409);
    const job = notify(env, target.id, `Support signed out all browsers and apps for your account in connection with ticket #${ticket}. Your password, passkeys and authenticator app remain unchanged.`);
    if (ctx) ctx.waitUntil(job); else await job;
    return view(env, user, '<p>All browsers, apps and pending sign-in proofs were revoked. MFA remains intact.</p><p><a href="/staff/accounts">Back to recovery tools</a></p>');
  }
  await env.DB.prepare('INSERT INTO support_recovery_audit (actor_id, target_id, action, ticket_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, target.id, action, ticket, reason, Date.now()).run();
  if (action === 'reset_email') {
    if (!target.email || target.banned) return view(env, user, '<p>This account cannot receive a password reset. Provider-only accounts must recover access with their sign-in provider.</p>', 400);
    if (!env.SMTP2GO_API_KEY) return view(env, user, '<p>Account email is temporarily unavailable.</p>', 503);
    if (!await limit(env, 'support-reset', target.id, 2, 3600) || !await limit(env, 'mail-email', target.email, 4, 3600)) return view(env, user, '<p>A recovery email was requested recently. Ask the user to check their inbox and spam folder.</p>', 429);
    const job = sendAccountToken(env, target.email, 'reset', target.id, {}, 'Reset your Blockworked password');
    if (ctx) ctx.waitUntil(job.catch(() => { console.error('Support recovery email could not be queued'); })); else await job;
    return view(env, user, '<p>A password reset email was requested for the existing verified address. Only the recipient can use the link. MFA remains required.</p><p><a href="/staff/accounts">Back to recovery tools</a></p>');
  }
  const keys = await env.DB.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id = ?').bind(target.id).first<{n: number}>();
  const app = await env.DB.prepare('SELECT 1 FROM totp_credentials WHERE user_id = ?').bind(target.id).first();
  const codes = await env.DB.prepare('SELECT count(*) AS n FROM backup_codes WHERE user_id = ?').bind(target.id).first<{n: number}>();
  const sessions = await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').bind(target.id, Date.now()).first<{n: number}>();
  const audit = await env.DB.prepare('SELECT action, actor_id, ticket_id, created_at FROM support_recovery_audit WHERE target_id = ? ORDER BY id DESC LIMIT 20').bind(target.id)
    .all<{action: string; actor_id: string; ticket_id: number; created_at: number}>();
  const hidden = `<input type="hidden" name="lookup" value="${esc(target.public_id)}"><input type="hidden" name="ticket" value="${ticket}"><input type="hidden" name="reason" value="${esc(reason)}">`;
  return view(env, user, `<h2>${esc(target.name)}</h2><p>Account ${esc(target.public_id)} · ${target.banned ? 'Banned' : 'Active'}</p>
    <p>Verified email: ${target.email ? esc(maskedEmail(target.email)) : 'None (provider sign-in)'}</p>
    <ul><li>Passkeys: ${keys?.n ?? 0}</li><li>Authenticator app: ${app ? 'Enabled' : 'Not enabled'}</li><li>Unused backup codes: ${codes?.n ?? 0}</li><li>Active sessions: ${sessions?.n ?? 0}</li></ul>
    <form method="post" action="/staff/accounts/reset">${hidden}<button ${target.email && !target.banned ? '' : 'disabled'}>Send password reset email</button></form>
    <form method="post" action="/staff/accounts/revoke">${hidden}<button>Revoke all browsers and apps</button></form>
    <p>Support cannot see recovery links or codes, change credentials, remove MFA, or sign in as this user.</p>
    <h2>Recent support recovery actions</h2><ul>${audit.results.map(row => `<li>${esc(row.action)} · ${esc(row.actor_id)} · ticket #${row.ticket_id} · ${esc(new Date(row.created_at).toISOString())}</li>`).join('')}</ul>`);
}

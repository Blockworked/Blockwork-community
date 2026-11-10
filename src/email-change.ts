import type { Env } from './index.ts';
import { hash, randomToken, type User } from './auth.ts';
import { accountPage } from './account-views.ts';
import { esc } from './pages.ts';
import { isEmail, normalizeEmail } from './support-mail.ts';
import { accountMail } from './account-mail.ts';
import { issueSession, limit, makeFlow, readFlow, securitySession, SECURITY_IDLE_MS, SECURITY_MAX_MS } from './account-security.ts';
import { CHANGE_GATE, commitCredentialChange } from './credential-change.ts';

interface Change { id: string; user_id: string; auth_version: number; old_email: string; new_email: string; old_token_hash: string | null; new_token_hash: string | null; cancel_token_hash: string; old_confirmed: number; new_confirmed: number }
const validChange = `SELECT c.* FROM email_changes c JOIN users u ON u.id = c.user_id JOIN email_credentials e ON e.user_id = c.user_id
  WHERE c.expires_at > ? AND c.auth_version = u.auth_version AND u.banned = 0 AND e.email = c.old_email`;
function result(env: Env, user: User | null, title: string, text: string, status = 200): Response {
  return accountPage(user, env, title, `<p>${esc(text)}</p><p><a href="/account/security">Account security</a></p>`, status);
}
export async function emailChange(req: Request, env: Env, user: User | null, body: Record<string, unknown> = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/account/email-change/approve' || path === '/account/email-change/cancel') {
    const token = req.method === 'GET' ? url.searchParams.get('token') ?? '' : typeof body.token === 'string' ? body.token : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return result(env, user, 'Email change expired', 'This confirmation link is no longer valid.', 400);
    const digest = await hash(token);
    const cancel = path.endsWith('/cancel');
    const change = await env.DB.prepare(`${validChange} AND ${cancel ? 'c.cancel_token_hash = ?' : '(c.old_token_hash = ? OR c.new_token_hash = ?)'}`)
      .bind(Date.now(), digest, ...(cancel ? [] : [digest])).first<Change>();
    if (!change) return result(env, user, 'Email change expired', 'This confirmation link is no longer valid.', 400);
    if (req.method === 'GET') {
      return accountPage(user, env, cancel ? 'Cancel email change' : 'Confirm email change', `<p>${cancel ? 'Cancel' : 'Approve'} the request to change the account email from <strong>${esc(change.old_email)}</strong> to <strong>${esc(change.new_email)}</strong>?</p>
        <form method="post" action="${path}"><input type="hidden" name="token" value="${esc(token)}"><button>${cancel ? 'Cancel email change' : 'Confirm this email address'}</button></form>
        <p>Both addresses must be confirmed. The account owner then finishes the change in unlocked Account security.</p>`);
    }
    if (cancel) {
      const deleted = await env.DB.prepare('DELETE FROM email_changes WHERE id = ? AND cancel_token_hash = ? RETURNING id').bind(change.id, digest).first();
      return result(env, user, 'Email change cancelled', deleted ? 'The pending change was cancelled. Your current email still works.' : 'This request was already handled.');
    }
    const old = change.old_token_hash === digest;
    const column = old ? 'old' : 'new';
    const accepted = await env.DB.prepare(`UPDATE email_changes SET ${column}_confirmed = 1, ${column}_token_hash = NULL WHERE id = ? AND ${column}_token_hash = ?
      AND expires_at > ? AND auth_version = (SELECT auth_version FROM users WHERE id = email_changes.user_id) RETURNING id`)
      .bind(change.id, digest, Date.now()).first();
    return result(env, user, 'Email address confirmed', accepted ? 'Return to Account security after confirming both addresses, then finish the email change. You may need to unlock settings again.' : 'This confirmation expired.', accepted ? 200 : 400);
  }
  const proof = user ? await securitySession(req, env, user) : null;
  if (!user || !proof) return result(env, user, 'Unlock security settings', 'Unlock Account security before changing your email.', 401);
  if (path === '/account/email-change/start') {
    if (!env.SMTP2GO_API_KEY) return result(env, user, 'Email unavailable', 'Account email is temporarily unavailable.', 503);
    const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
    if (!isEmail(email)) return result(env, user, 'Email change', 'Enter a valid email address.', 400);
    const current = await env.DB.prepare('SELECT email FROM email_credentials WHERE user_id = ?').bind(user.id).first<{email: string}>();
    if (!current) return result(env, user, 'Email change', 'Add verified email credentials before changing the email.', 400);
    if (current.email === email) return result(env, user, 'Email change', 'Enter a different email address.', 400);
    if (!await limit(env, 'email-change-user', user.id, 3, 3600) || !await limit(env, 'mail-email', email, 4, 3600)) return result(env, user, 'Email change', 'Too many requests. Try again in an hour.', 429);
    const known = await env.DB.prepare('SELECT 1 FROM email_credentials WHERE email = ?').bind(email).first();
    if (known) return result(env, user, 'Email change', 'That address cannot be used for this change.', 409);
    const oldToken = randomToken(), newToken = randomToken(), cancelToken = randomToken();
    const id = crypto.randomUUID(), now = Date.now();
    const created = await env.DB.prepare(`INSERT INTO email_changes (id,user_id,auth_version,old_email,new_email,old_token_hash,new_token_hash,cancel_token_hash,expires_at)
      SELECT ?,u.id,u.auth_version,?,?,?,?,?,? FROM users u JOIN email_credentials e ON e.user_id = u.id WHERE u.id = ? AND u.auth_version = ? AND u.banned = 0 AND e.email = ?
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = u.id AND expires_at > ? AND security_unlocked_at > ? AND security_last_used_at > ?)
      ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,auth_version=excluded.auth_version,old_email=excluded.old_email,new_email=excluded.new_email,
      old_token_hash=excluded.old_token_hash,new_token_hash=excluded.new_token_hash,cancel_token_hash=excluded.cancel_token_hash,old_confirmed=0,new_confirmed=0,expires_at=excluded.expires_at`)
      .bind(id, current.email, email, await hash(oldToken), await hash(newToken), await hash(cancelToken), now + 3600000,
        user.id, proof.auth_version, current.email, proof.token_hash, now, now - SECURITY_MAX_MS, now - SECURITY_IDLE_MS).run();
    if (created.meta.changes !== 1) return result(env, user, 'Email change', 'Your account changed. Unlock settings and try again.', 409);
    const origin = new URL(env.SITE_URL).origin;
    const link = (action: string, token: string) => `${origin}/account/email-change/${action}?token=${token}`;
    const sent = await Promise.all([
      accountMail(env, current.email, 'Approve your Blockworked email change', `A change to your account email was requested. The current email still works until both addresses are confirmed and you finish the change in Account security.\n\nApprove this request:\n${link('approve', oldToken)}\n\nIf you did not request this, cancel it:\n${link('cancel', cancelToken)}\n\nThese links expire in one hour. Support cannot change your email for you.`),
      accountMail(env, email, 'Verify your new Blockworked email', `Verify this address for a Blockworked email change:\n${link('approve', newToken)}\n\nThis link expires in one hour. Verification alone does not sign you in or change the account. If you did not request this, ignore the email.`),
    ]);
    if (sent.some(v => !v)) {
      await env.DB.prepare('DELETE FROM email_changes WHERE id = ?').bind(id).run();
      return result(env, user, 'Email unavailable', 'Both confirmation emails could not be sent. Your email has not changed. Try again later.', 503);
    }
    return result(env, user, 'Confirm both email addresses', 'Confirmation emails were sent to your current and new addresses. Confirm both within one hour, then finish the change in Account security.');
  }
  if (path === '/account/email-change/finish') {
    const change = await env.DB.prepare(`${validChange} AND c.user_id = ? AND c.old_confirmed = 1 AND c.new_confirmed = 1`).bind(Date.now(), user.id).first<Change>();
    if (!change) return result(env, user, 'Email change', 'Confirm both addresses before finishing the change.', 400);
    const token = await makeFlow(env, 'email-change-finish', user.id, {}, 600, proof.auth_version);
    const flow = await readFlow(env, token, 'email-change-finish');
    if (!flow) return result(env, user, 'Email change', 'This request expired.', 400);
    try {
      const done = await commitCredentialChange(env, flow, proof, {
        sql: `EXISTS (SELECT 1 FROM email_changes c JOIN email_credentials e ON e.user_id = c.user_id WHERE c.id = ? AND c.user_id = ? AND c.auth_version = ? AND c.old_confirmed = 1 AND c.new_confirmed = 1 AND c.expires_at > ? AND e.email = c.old_email)
          AND NOT EXISTS (SELECT 1 FROM email_credentials WHERE email = ? AND user_id != ?)`,
        params: [change.id, user.id, proof.auth_version, Date.now(), change.new_email, user.id],
      }, [{sql: `UPDATE email_credentials SET email = ? WHERE user_id = ? AND email = ? AND ${CHANGE_GATE}`, params: [change.new_email, user.id, change.old_email]}], 'email_changed');
      if (!done) return result(env, user, 'Email change', 'This request expired or the address is unavailable. Your email was not changed.', 409);
    } catch { return result(env, user, 'Email change', 'The change could not be completed. Your current address still works.', 409); }
    const text = 'Your Blockworked account email was changed. Other browsers, apps and pending recovery links were signed out or invalidated. Your password, passkeys, authenticator app and backup codes are unchanged. If this was not you, contact support immediately.';
    const notices = await Promise.all([change.old_email, change.new_email].map(to => accountMail(env, to, 'Blockworked email changed', text)));
    if (notices.some(v => !v)) console.error('Email change security notice delivery failed');
    return issueSession(env, user.id, proof.auth_version + 1, proof.auth_strength, '/account/security', proof.security_unlocked_at);
  }
  return result(env, user, 'Not found', 'There is nothing here.', 404);
}

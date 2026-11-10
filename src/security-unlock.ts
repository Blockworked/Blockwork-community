import type { Env } from './index.ts';
import { cookie, cookies, hash, safeNext, type User, PROVIDERS } from './auth.ts';
import { esc } from './pages.ts';
import { accountPage } from './account-views.ts';
import { makeFlow, readFlow, redirect } from './account-security.ts';

const COOKIE = '__Host-settings-reauth';
function reauthCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${token ? 600 : 0}; Secure; HttpOnly; SameSite=Lax`;
}
export async function securityUnlock(req: Request, env: Env, user: User | null): Promise<Response> {
  if (!user) return redirect('/login?next=%2Faccount');
  const url = new URL(req.url);
  const hashes = await Promise.all(cookies(req, 'session').slice(0, 2).map(hash));
  const session = await env.DB.prepare(`SELECT token_hash, created_at, auth_strength FROM sessions WHERE user_id = ? AND kind = 'web' AND expires_at > ? AND token_hash IN (?, ?) LIMIT 1`)
    .bind(user.id, Date.now(), hashes[0] ?? '', hashes[1] ?? '').first<{token_hash: string; created_at: number; auth_strength: string}>();
  if (!session) return redirect('/login?next=%2Faccount');
  if (req.method === 'POST' && url.pathname === '/account/lock') {
    await env.DB.prepare('UPDATE sessions SET security_unlocked_at = 0, security_last_used_at = 0 WHERE token_hash = ? AND user_id = ?').bind(session.token_hash, user.id).run();
    return redirect('/account/unlock');
  }
  if (req.method !== 'GET') return new Response('Method not allowed', {status: 405});
  if (url.pathname === '/account/unlock/complete') {
    const token = url.searchParams.get('token') ?? '';
    const flow = cookie(req, COOKIE) === token ? await readFlow(env, token, 'settings-unlock') : null;
    if (!flow || flow.user_id !== user.id) return accountPage(user, env, 'Unlock security settings', '<p>This confirmation expired or belongs to another account. <a href="/account/unlock">Try again</a>.</p>', 400);
    const data = JSON.parse(flow.data);
    const hasFactor = await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ? UNION ALL SELECT 1 FROM totp_credentials WHERE user_id = ? LIMIT 1').bind(user.id, user.id).first();
    if (session.token_hash === data.session_hash || session.created_at < data.started_at || !['strong','totp','recovery', ...(!hasFactor ? ['primary'] : [])].includes(session.auth_strength)) {
      return accountPage(user, env, 'Unlock security settings', '<p>Confirm your identity to continue. <a href="/account/unlock">Try again</a>.</p>', 403);
    }
    const now = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE sessions SET security_unlocked_at = ?, security_last_used_at = ? WHERE token_hash = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM auth_flows f JOIN users u ON u.id = f.user_id WHERE f.token_hash = ? AND f.expires_at > ? AND f.auth_version = u.auth_version AND u.banned = 0)`)
        .bind(now, now, session.token_hash, user.id, flow.token_hash, now),
      env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ? AND user_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND security_unlocked_at = ?)`)
        .bind(data.session_hash, user.id, session.token_hash, now),
      env.DB.prepare('DELETE FROM auth_flows WHERE token_hash = ?').bind(flow.token_hash),
    ]);
    if (results[0].meta.changes !== 1) return redirect('/account/unlock');
    const response = redirect(safeNext(data.next, env));
    response.headers.append('Set-Cookie', reauthCookie(''));
    return response;
  }
  const next = url.searchParams.get('next') === '/staff/accounts' ? '/staff/accounts' : '/account';
  const token = await makeFlow(env, 'settings-unlock', user.id, {session_hash: session.token_hash, started_at: Date.now(), next});
  const complete = `/account/unlock/complete?token=${token}`;
  const email = await env.DB.prepare('SELECT email FROM email_credentials WHERE user_id = ?').bind(user.id).first<{email: string}>();
  const providers = await env.DB.prepare('SELECT provider FROM oauth_identities WHERE user_id = ?').bind(user.id).all<{provider: keyof typeof PROVIDERS}>();
  const key = await env.DB.prepare('SELECT 1 FROM passkeys WHERE user_id = ?').bind(user.id).first();
  const response = accountPage(user, env, 'Unlock security settings', `<p>Confirm your identity for ${esc(user.name)} to open security settings. Settings lock after 30 minutes of inactivity or one hour total.</p>
    ${email ? `<form method="post" action="/auth/email/login"><input type="hidden" name="email" value="${esc(email.email)}"><input type="hidden" name="next" value="${esc(complete)}"><p><label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="128"></label></p><button>Continue with password</button></form>` : ''}
    ${key ? `<p><button type="button" data-passkey="login" data-next="${esc(complete)}">Unlock with a passkey</button></p>` : ''}
    <div class="signin">${providers.results.map(p => `<a class="button" href="/auth/${p.provider}/login?next=${encodeURIComponent(complete)}">Continue with ${esc(PROVIDERS[p.provider])}</a>`).join('')}</div>
    <p id="auth-status" role="status"></p><script src="/account.js" defer></script>`);
  response.headers.append('Set-Cookie', reauthCookie(token));
  return response;
}

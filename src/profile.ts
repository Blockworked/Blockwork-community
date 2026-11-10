import type { Env } from './index.ts';
import { cookies, hash, isAdmin, isReservedName, type User } from './auth.ts';
import { boundedBody, limit, redirect } from './account-security.ts';
import { settingsPage } from './account-views.ts';
import { cleanProfilePng } from './profile-image.ts';
import { esc } from './pages.ts';

export const USERNAME_COOLDOWN = 30 * 86400_000;
const RESERVED = new Set(['admin','admins','administrator','support','security','moderator','moderators','staff','team','system','root','noreply','no_reply','official','help','api','account','settings','deleted','anonymous']);
export function usernameError(username: string, team = false): string | null {
  if (!/^[a-z][a-z0-9_]{2,29}$/.test(username)) return 'Use 3–30 letters, numbers or underscores, starting with a letter.';
  if (RESERVED.has(username.replace(/_/g,'')) || (!team && isReservedName(username))) return 'That username is reserved.';
  return null;
}
const field = (body: Record<string, unknown>, key: string) => typeof body[key] === 'string' ? body[key] as string : '';

export async function profileRoute(req: Request, env: Env, user: User | null): Promise<Response> {
  if (!user) return redirect('/login?next=%2Faccount%2Fprofile');
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/account') return redirect('/account/profile');
  if (req.method === 'GET' && path === '/account/profile') return profilePage(env, user);
  if (req.method !== 'POST') return new Response('Method not allowed', {status: 405});
  const fail = (message: string, status = 400) => path.endsWith('/picture') ? Promise.resolve(Response.json({error:message},{status})) : profilePage(env, user, message, status);
  if (!await limit(env, 'profile-edit', user.id, 20, 3600)) return fail('Too many profile updates. Try again in an hour.', 429);
  let body: Record<string, unknown>;
  try { body = await boundedBody(req, path.endsWith('/picture') ? 360000 : 2000); }
  catch { return fail('The upload is too large or invalid.', 413); }
  const now = Date.now();
  const hashes = await Promise.all(cookies(req, 'session').slice(0,2).map(hash));
  // Recheck the browser session at the write, including after image processing.
  const guard = `id = ? AND banned = 0 AND EXISTS (SELECT 1 FROM sessions WHERE user_id = users.id AND kind = 'web' AND expires_at > ? AND token_hash IN (?,?))`;
  const guardValues = () => [user.id, Date.now(), hashes[0] ?? '', hashes[1] ?? ''];
  if (path.endsWith('/picture')) {
    if (!await limit(env, 'profile-picture', user.id, 10, 3600)) return fail('Too many picture changes. Try again in an hour.', 429);
    const data = field(body,'png');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4) return fail('Choose a picture to upload.');
    let bytes: Uint8Array;
    try { bytes = await cleanProfilePng(Uint8Array.from(atob(data), c => c.charCodeAt(0))); }
    catch (e) { return fail(e instanceof Error ? e.message : 'Invalid picture.'); }
    const id = crypto.randomUUID(), avatar = new URL(`/avatars/${id}.png`,env.SITE_URL).href;
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET avatar = ? WHERE ${guard}`).bind(avatar,...guardValues()),
      env.DB.prepare('INSERT INTO profile_pictures (user_id,id,png) SELECT id,?,? FROM users WHERE id = ? AND avatar = ? ON CONFLICT(user_id) DO UPDATE SET id = excluded.id, png = excluded.png').bind(id,btoa(binary),user.id,avatar),
    ]);
    if (result[0].meta.changes !== 1) return fail('Sign in again before editing your profile.',401);
    return Response.json({next:'/account/profile?saved=1'});
  }
  const action = field(body,'action');
  if (action === 'picture-remove') {
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE users SET avatar = '' WHERE ${guard}`).bind(...guardValues()),
      env.DB.prepare("DELETE FROM profile_pictures WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND avatar = '')").bind(user.id,user.id),
    ]);
    if (result[0].meta.changes !== 1) return fail('Sign in again before editing your profile.',401);
  } else if (action === 'name') {
    const name = field(body,'name').trim().normalize('NFC');
    if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) || (isReservedName(name) && !isAdmin(env,user))) return fail('Choose a display name between 1 and 80 characters. Team names are reserved.');
    const result = await env.DB.prepare(`UPDATE users SET name = ? WHERE ${guard}`).bind(name,...guardValues()).run();
    if (result.meta.changes !== 1) return fail('Sign in again before editing your profile.',401);
  } else if (action === 'username') {
    const username = field(body,'username').trim().toLowerCase();
    const problem = usernameError(username,isAdmin(env,user));
    if (problem) return fail(problem);
    const current = await env.DB.prepare('SELECT username,username_changed_at FROM users WHERE id = ?').bind(user.id).first<{username:string|null; username_changed_at:number}>();
    if (current?.username === username) return redirect('/account/profile?saved=1');
    if (current && current.username_changed_at > now - USERNAME_COOLDOWN) {
      const response = await fail('You can change your username once every 30 days.',429);
      response.headers.set('Retry-After',String(Math.ceil((current.username_changed_at + USERNAME_COOLDOWN - now)/1000))); return response;
    }
    let changed = false;
    try {
      const result = await env.DB.prepare(`UPDATE users SET username = ?, username_changed_at = ? WHERE ${guard}
        AND username_changed_at <= ? AND NOT EXISTS (SELECT 1 FROM username_history WHERE username = ? AND user_id != ? AND hold_until > ?)`)
        .bind(username,now,...guardValues(),now - USERNAME_COOLDOWN,username,user.id,now).run();
      changed = result.meta.changes === 1;
    } catch (e) {
      if (!String(e).includes('UNIQUE constraint')) throw e;
    }
    if (!changed) return fail('That username is unavailable, or your profile changed. Refresh and try again.',409);
  } else return fail('Unknown profile update.');
  return redirect('/account/profile?saved=1');
}
async function profilePage(env: Env, user: User, error = '', status = 200): Promise<Response> {
  const profile = await env.DB.prepare('SELECT username,username_changed_at FROM users WHERE id = ?').bind(user.id).first<{username:string|null;username_changed_at:number}>();
  const available = profile && profile.username_changed_at > Date.now() - USERNAME_COOLDOWN ? new Date(profile.username_changed_at + USERNAME_COOLDOWN).toISOString().slice(0,10) : '';
  return settingsPage(user,env,'Profile',`${error ? `<p role="alert">${esc(error)}</p>` : ''}
    <section class="card"><h3>Display name</h3><form method="post" action="/account/profile"><input type="hidden" name="action" value="name"><p><label>Display name<br><input name="name" type="text" autocomplete="nickname" maxlength="80" required value="${esc(user.name)}"></label></p><button>Save display name</button></form></section>
    <section class="card"><h3>Username</h3><form method="post" action="/account/profile"><input type="hidden" name="action" value="username"><p><label>Username<br><input name="username" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="30" pattern="[A-Za-z][A-Za-z0-9_]{2,29}" required value="${esc(profile?.username ?? '')}"></label></p><p class="muted">3–30 letters, numbers or underscores. Starts with a letter. Changes are limited to once every 30 days.${available ? ` Next change: ${esc(available)}.` : ''}</p><button ${available ? 'disabled' : ''}>Save username</button></form>${profile?.username ? `<p><a href="/@${esc(profile.username)}">View public profile · @${esc(profile.username)}</a></p>` : ''}</section>
    <section class="card"><h3>Profile picture</h3>${user.avatar ? `<p><img class="profile-picture" src="${esc(user.avatar)}" alt="Current profile picture"></p>` : ''}
    <form id="profile-picture-form"><p><label>Profile picture<br><input name="picture" type="file" accept="image/png,image/jpeg,image/webp" required></label></p><button>Upload picture</button></form><p class="muted">PNG, JPEG or WebP, up to 5 MiB. Pictures are cropped to a square.</p>
    ${user.avatar ? '<form method="post" action="/account/profile"><input type="hidden" name="action" value="picture-remove"><button>Remove picture</button></form>' : ''}</section>
    <p id="auth-status" role="status"></p><script src="/account.js" defer></script>`,status);
}
export async function profilePicture(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT p.png FROM profile_pictures p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.banned = 0').bind(id).first<{png:string}>();
  if (!row) return new Response('Not found',{status:404});
  const bytes = Uint8Array.from(atob(row.png),c => c.charCodeAt(0));
  return new Response(bytes,{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline; filename="avatar.png"'}});
}

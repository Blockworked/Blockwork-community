import type { Env } from './index.ts';
import { isAdmin, type User } from './auth.ts';
import { esc, page } from './pages.ts';
export function settingsPage(user: User, env: Env, section: 'Profile' | 'Security', html: string, status = 200): Response {
  return accountPage(user, env, 'Account settings', `<div class="settings-layout"><nav class="settings-nav" aria-label="Account settings">
    <a href="/account/profile" ${section === 'Profile' ? 'aria-current="page"' : ''}>Profile</a>
    <a href="/account/security" ${section === 'Security' ? 'aria-current="page"' : ''}>Security</a>
    </nav><div class="settings-content"><h2>${section === 'Security' ? 'Account security' : 'Profile'}</h2>${html}</div></div>`, status);
}
export function accountPage(user: User | null, env: Env, title: string, html: string, status = 200): Response {
  const response = page(title, user, isAdmin(env, user), `<h1>${esc(title)}</h1>${html}`, status);
  response.headers.set('Cache-Control', 'no-store');
  // no-referrer makes browser navigation POSTs send Origin: null. Origin-only
  // referrers hide link tokens while preserving exact-Origin CSRF verification.
  response.headers.set('Referrer-Policy', 'strict-origin');
  return response;
}

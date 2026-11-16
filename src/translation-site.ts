import type { Env } from './index.ts';

/** A path mount is useful locally; production uses the dedicated translation host. */
export function translationSite(env: Pick<Env, 'SITE_URL' | 'TRANSLATE_URL'>): URL {
  return new URL(env.TRANSLATE_URL || `${env.SITE_URL.replace(/\/$/, '')}/translate`);
}
export function translationPath(env: Env, url: URL): string | null {
  const site = translationSite(env), base = site.pathname.replace(/\/$/, '');
  if (url.origin !== site.origin) return null;
  if (url.pathname === base || url.pathname === base + '/') return '/translate';
  return url.pathname.startsWith(base + '/') ? '/translate' + url.pathname.slice(base.length).replace(/\/$/, '') : null;
}
export function translationLink(env: Env, path = '/translate'): string {
  const site = translationSite(env);
  const base = site.pathname.replace(/\/$/, '');
  const suffix = path.slice('/translate'.length);
  const origin = site.origin === new URL(env.SITE_URL).origin ? '' : site.origin;
  return origin + base + suffix || '/';
}
export function translationLogin(env: Env, path = '/translate'): string {
  const target = translationLink(env, path);
  const origin = translationSite(env).origin === new URL(env.SITE_URL).origin ? '' : new URL(env.SITE_URL).origin;
  return `${origin}/login?next=${encodeURIComponent(target)}`;
}

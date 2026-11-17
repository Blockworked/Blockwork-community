// The site's language. English text is the message id (gettext); catalogs come
// from locales/*.po through scripts/i18n.mjs compile. The language is per request,
// so t() works anywhere below route() without passing it around.
import { AsyncLocalStorage } from 'node:async_hooks';
import { CATALOGS } from './locales.generated.ts';

export interface Catalog {
  tag: string; name: string; dir: 'ltr' | 'rtl'; offered: boolean; complete: number;
  plural: (n: number) => number; messages: Record<string, string[]>;
}
interface Current { code: string; catalog?: Catalog }
const store = new AsyncLocalStorage<Current>();
/** The cookie both Blockworked sites keep the chosen language in. */
export const LANGUAGE_COOKIE = 'bw-lang';

/** A value that is already HTML and goes into a message as is. */
export class Html { readonly html: string; constructor(html: string) { this.html = html; } toString() { return this.html; } }
export const raw = (html: string) => new Html(html);
type Vars = Record<string, string | number | Html>;

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
function fill(text: string, vars: Vars | undefined, html: boolean): string {
  const body = html ? escape(text) : text;
  if (!vars) return body;
  return body.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    if (!Object.hasOwn(vars, name)) return whole;
    const v = vars[name];
    if (v instanceof Html) return html ? v.html : v.html.replace(/<[^>]*>/g, '');
    return html ? escape(typeof v === 'number' ? v.toLocaleString(current().catalog?.tag ?? 'en') : v) : String(v);
  });
}
function current(): Current { return store.getStore() ?? { code: 'en' }; }
function lookup(id: string): string | undefined { return current().catalog?.messages[id]?.[0]; }

/** The translation of a message, escaped for HTML. Placeholders look like {name}. */
export function t(id: string, vars?: Vars): string { return fill(lookup(id) ?? id, vars, true); }
/** The same as plain text, for titles, headers and attributes that escape themselves. */
export function tp(id: string, vars?: Vars): string { return fill(lookup(id) ?? id, vars, false); }
/** A message with plural forms; {n} is the count. */
export function tn(one: string, other: string, n: number, vars?: Vars): string {
  const catalog = current().catalog, forms = catalog?.messages[one];
  const text = forms ? forms[Math.min(forms.length - 1, catalog!.plural(n))] : n === 1 ? one : other;
  return fill(text, { n, ...vars }, true);
}

/** The current language: its code, BCP 47 tag and direction. */
export function language(): { code: string; tag: string; dir: 'ltr' | 'rtl' } {
  const { code, catalog } = current();
  return { code, tag: catalog?.tag ?? 'en', dir: catalog?.dir ?? 'ltr' };
}
/** Languages people can pick, English first. */
export function languages(): { code: string; tag: string; name: string }[] {
  return [{ code: 'en', tag: 'en', name: 'English' }, ...Object.entries(CATALOGS).filter(([, c]) => c.offered)
    .map(([code, c]) => ({ code, tag: c.tag, name: c.name })).sort((a, b) => a.name.localeCompare(b.name))];
}

function offered(code: string): string | null {
  if (code === 'en') return 'en';
  const exact = Object.keys(CATALOGS).find(c => CATALOGS[c].offered && (c.toLowerCase() === code.toLowerCase() || CATALOGS[c].tag.toLowerCase() === code.toLowerCase()));
  return exact ?? null;
}
/** The chosen language (cookie), else the browser's best offered one, else English. */
export function negotiate(req: Request): string {
  const cookie = /(?:^|;\s*)bw-lang=([A-Za-z0-9_@-]{2,20})/.exec(req.headers.get('Cookie') ?? '')?.[1];
  if (cookie) return offered(cookie) ?? 'en';
  const wanted = (req.headers.get('Accept-Language') ?? '').split(',').slice(0, 12).map(part => {
    const [tag, q] = part.trim().split(';q=');
    return { tag: tag.trim(), q: q === undefined ? 1 : Number(q) || 0 };
  }).filter(w => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(w.tag) && w.q > 0).sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const exact = offered(tag) ?? offered(tag.split('-')[0]);
    if (exact) return exact;
  }
  return 'en';
}

/** Runs a request in a language. */
export function inLanguage<T>(code: string, run: () => T): T {
  return store.run({ code, catalog: code === 'en' ? undefined : CATALOGS[code] }, run);
}

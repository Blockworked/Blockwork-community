// Server-only Weblate client. Never follow API-supplied URLs with credentials.
import { hash, type User } from './auth.ts';
import type { Env } from './index.ts';

export interface Translation {
  language: { code: string; name: string; direction: string; plural: { number: number; formula: string } };
  total: number; translated: number; translated_percent: number; fuzzy: number; is_source: boolean;
}
export interface Unit {
  id: number; source: string[]; target: string[]; state: number; content_hash: string;
  context: string; note: string; explanation: string; location: string; flags: string;
  translation: string; has_failing_check: boolean;
  previous_source?: string; source_unit?: string | null; language_code?: string;
  has_suggestion?: boolean; has_comment?: boolean; position?: number;
}
export interface Suggestion { id: number; unit: string; target: string[]; timestamp: string; votes: number }
export interface Comment { id: number; comment: string; timestamp: string }
export interface Screenshot { id: number; name: string; translation: string }
export interface GlossaryTerm { source: string; target: string; note: string }
export class WeblateError extends Error {
  status: number;
  constructor(status = 503) { super('Translation service unavailable'); this.status = status; }
}
export function components(env: Env): string[] {
  return [...new Set((env.WEBLATE_COMPONENTS ?? '').split(',').map(s => s.trim()).filter(s => /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(s)))];
}
export function apiBase(env: Env): URL {
  const base = new URL(env.WEBLATE_URL || 'https://unconfigured.invalid');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new WeblateError();
  if (env.TRANSLATE_URL && base.origin === new URL(env.TRANSLATE_URL).origin) throw new WeblateError();
  return base;
}
export async function signedHeaders(secret: string, user: User, method: string, path: string, body: string): Promise<Record<string, string>> {
  const identity = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ id: user.id, name: user.name })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const canonical = [timestamp, nonce, identity, method, path, await hash(body)].join('\n');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return {
    'X-Blockworked-Identity': identity, 'X-Blockworked-Time': timestamp, 'X-Blockworked-Nonce': nonce,
    'X-Blockworked-Signature': Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join(''),
  };
}
export async function webRequest<T>(env: Env, path: string, body?: object, user?: User, verb: 'PATCH' | 'POST' = 'PATCH'): Promise<T> {
  const base = apiBase(env);
  if (!path.startsWith('/api/') || new URL(path, base).origin !== base.origin) throw new WeblateError();
  const method = body ? verb : 'GET';
  const json = body ? JSON.stringify(body) : '';
  const headers: Record<string, string> = {Accept: 'application/json', 'User-Agent': 'Blockworked-Translations/1.0 (+https://blockworked.com)'};
  if (body) {
    if (!user || !env.WEBLATE_SHARED_SECRET || env.WEBLATE_SHARED_SECRET.length < 32) throw new WeblateError();
    Object.assign(headers, await signedHeaders(env.WEBLATE_SHARED_SECRET, user, method, path, json));
    headers['Content-Type'] = 'application/json';
  } else if (env.WEBLATE_READ_TOKEN) headers.Authorization = `Token ${env.WEBLATE_READ_TOKEN}`;
  let response: Response;
  try {
    response = await fetch(new URL(path, base), { method, headers, body: json || undefined, redirect: 'manual', signal: AbortSignal.timeout(12000) });
  } catch { throw new WeblateError(); }
  if (!response.ok) throw new WeblateError([400, 403, 404, 409, 429].includes(response.status) ? response.status : 503);
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; } catch { throw new WeblateError(); }
}
export async function translations(env: Env, component: string): Promise<Translation[]> {
  const result: Translation[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await webRequest<{results: Translation[]; next: string | null}>(env, `/api/components/${component}/translations/?page_size=100&page=${page}`);
    result.push(...data.results.filter(t => !t.is_source));
    if (!data.next) return result.sort((a,b) => a.language.name.localeCompare(b.language.name));
  }
  throw new WeblateError();
}
export async function snapshot(unit: Unit): Promise<string> {
  return hash(JSON.stringify([unit.id, unit.source, unit.target, unit.state, unit.content_hash]));
}
export function belongsTo(env: Env, unit: Unit, component: string, language: string): boolean {
  try {
    const url = new URL(unit.translation);
    return url.origin === apiBase(env).origin && decodeURIComponent(url.pathname) === `/api/translations/${component}/${language}/`;
  } catch { return false; }
}

/** The numeric id at the end of an API link from Weblate, only when it points at our backend. */
export function idFrom(env: Env, link: string | null | undefined, kind: 'units' | 'screenshots'): number | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    const match = new RegExp(`^/api/${kind}/([1-9]\\d{0,12})/$`).exec(url.pathname);
    return url.origin === apiBase(env).origin && match ? Number(match[1]) : null;
  } catch { return null; }
}
/** project/component/language of a translation link, when it is ours. */
export function translationOf(env: Env, link: string): {component: string; language: string} | null {
  try {
    const url = new URL(link);
    const match = /^\/api\/translations\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([^/]+)\/$/.exec(url.pathname);
    if (url.origin !== apiBase(env).origin || !match) return null;
    return {component: `${match[1]}/${match[2]}`, language: decodeURIComponent(match[3])};
  } catch { return null; }
}
async function list<T>(env: Env, path: string): Promise<T[]> {
  const data = await webRequest<{results: T[]} | T[]>(env, path);
  return Array.isArray(data) ? data : data.results;
}
/** The same string in every other language, from its source unit. */
export async function otherLanguages(env: Env, unit: Unit): Promise<Unit[]> {
  const source = idFrom(env, unit.source_unit, 'units');
  if (!source) return [];
  return (await list<Unit>(env, `/api/units/${source}/translations/`)).filter(u => u.id !== unit.id && u.target.some(Boolean));
}
export function suggestions(env: Env, unit: number): Promise<Suggestion[]> { return list<Suggestion>(env, `/api/units/${unit}/suggestions/?page_size=50`); }
export function comments(env: Env, unit: number): Promise<Comment[]> { return list<Comment>(env, `/api/units/${unit}/comments/?page_size=50`); }
/** Screenshots hang off the source string, so ask there. */
export async function screenshots(env: Env, unit: Unit): Promise<Screenshot[]> {
  const source = idFrom(env, unit.source_unit, 'units') ?? unit.id;
  return list<Screenshot>(env, `/api/units/${source}/screenshots/?page_size=20`);
}
export async function screenshotFile(env: Env, id: number): Promise<Response> {
  const shot = await webRequest<Screenshot>(env, `/api/screenshots/${id}/`);
  const where = translationOf(env, shot.translation);
  if (!where || !components(env).includes(where.component)) throw new WeblateError(404);
  const headers: Record<string, string> = {'User-Agent': 'Blockworked-Translations/1.0 (+https://blockworked.com)'};
  if (env.WEBLATE_READ_TOKEN) headers.Authorization = `Token ${env.WEBLATE_READ_TOKEN}`;
  let response: Response;
  try { response = await fetch(new URL(`/api/screenshots/${id}/file/`, apiBase(env)), {headers, redirect: 'manual', signal: AbortSignal.timeout(12000)}); }
  catch { throw new WeblateError(); }
  const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim();
  if (!response.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw new WeblateError(response.status === 404 ? 404 : 503);
  return new Response(response.body, {headers: {'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'"}});
}

// Glossaries are small and change rarely; keep one per language for a few minutes.
const glossaries = new Map<string, {at: number; terms: GlossaryTerm[]}>();
/** The project's Weblate glossary in one language; empty when the project has none. */
export async function glossary(env: Env, component: string, language: string): Promise<GlossaryTerm[]> {
  const project = component.split('/')[0], key = `${project}/${language}`;
  const cached = glossaries.get(key);
  if (cached && Date.now() - cached.at < 300000) return cached.terms;
  let terms: GlossaryTerm[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const data = await webRequest<{results: Unit[]; next: string | null}>(env, `/api/translations/${project}/glossary/${encodeURIComponent(language)}/units/?page_size=500&page=${page}`);
      terms.push(...data.results.map(u => ({source: u.source[0] ?? '', target: u.target[0] ?? '', note: u.explanation || u.note || ''})).filter(t => t.source));
      if (!data.next) break;
    }
  } catch (error) {
    if (!(error instanceof WeblateError) || error.status !== 404) throw error;
    terms = [];
  }
  glossaries.set(key, {at: Date.now(), terms});
  return terms;
}
/** Glossary entries whose source term appears in the text as a whole word. */
export function termsIn(text: string, terms: GlossaryTerm[]): GlossaryTerm[] {
  const lower = text.toLocaleLowerCase();
  return terms.filter(t => {
    const term = t.source.toLocaleLowerCase(), at = lower.indexOf(term);
    if (at < 0) return false;
    const before = lower[at - 1] ?? ' ', after = lower[at + term.length] ?? ' ';
    return !/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after);
  }).slice(0, 12);
}
/** Adds a language to a component with the dedicated language manager token. */
export async function addLanguage(env: Env, component: string, code: string): Promise<void> {
  if (!env.WEBLATE_LANGUAGE_TOKEN) throw new WeblateError(403);
  const base = apiBase(env), path = `/api/components/${component}/translations/`;
  let response: Response;
  try {
    response = await fetch(new URL(path, base), {method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Token ${env.WEBLATE_LANGUAGE_TOKEN}`, 'User-Agent': 'Blockworked-Translations/1.0 (+https://blockworked.com)'},
      body: JSON.stringify({language_code: code})});
  } catch { throw new WeblateError(); }
  if (!response.ok) throw new WeblateError([400, 403, 404, 409, 429].includes(response.status) ? response.status : 503);
}

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
}
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
export async function webRequest<T>(env: Env, path: string, body?: object, user?: User): Promise<T> {
  const base = apiBase(env);
  if (!path.startsWith('/api/') || new URL(path, base).origin !== base.origin) throw new WeblateError();
  const method = body ? 'PATCH' : 'GET';
  const json = body ? JSON.stringify(body) : '';
  const headers: Record<string, string> = {Accept: 'application/json'};
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
    return url.origin === apiBase(env).origin && url.pathname === `/api/translations/${component}/${encodeURIComponent(language)}/`;
  } catch { return false; }
}

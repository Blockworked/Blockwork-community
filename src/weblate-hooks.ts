// Keep existing GitHub webhooks working when the public translation host moves.
// Weblate continues to validate hook signatures/payloads and schedule repository sync.
import type { Env } from './index.ts';
import { apiBase } from './weblate.ts';

export async function webLateGithubHook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', {status:405,headers:{Allow:'POST'}});
  try {
    const target = new URL('/hooks/github/',apiBase(env));
    target.search = new URL(req.url).search;
    const headers = new Headers(req.headers);
    headers.delete('Host');
    headers.delete('Cookie');
    headers.delete('Connection');
    headers.set('User-Agent','Blockworked-Translations/1.0 (+https://blockworked.com)');
    return await fetch(target,{method:'POST',headers,body:req.body,redirect:'manual',signal:AbortSignal.timeout(12000)});
  } catch { return new Response('Translation webhook temporarily unavailable', {status:503}); }
}

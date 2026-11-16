import { translationSite, translationPath, translationLink, translationLogin } from './translation-site.ts';
import { isAdmin, type User } from './auth.ts';
import { boundedBody, limit } from './account-security.ts';
import type { Env } from './index.ts';
import { esc, page, type Shell } from './pages.ts';
import { belongsTo, components, snapshot, translations, webRequest, WeblateError, type Translation, type Unit } from './weblate.ts';
import { TRANSLATE_CSS, TRANSLATE_JS } from './translate-ui.ts';

const ROOT = '/translate';
function shell(env: Env, user: User | null): Shell {
  return { name: 'Translations', href: translationLink(env), site: 'Blockworked Translations', place: {community: `${env.SITE_URL}/`, section: 'translations'},
    nav: user ? `<a href="${esc(env.SITE_URL)}/account">Account settings</a><span class="who">${esc(user.name)}</span>` : `<a href="${esc(translationLogin(env))}">Sign in with Blockworked</a>` };
}
function render(env: Env, user: User | null, title: string, body: string, status = 200): Response {
  const response = page(title, user, isAdmin(env, user), `<style>${TRANSLATE_CSS}</style><div class="translations">${body}</div><script src="/translate.js" defer></script>`, status, shell(env,user));
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
function redirect(path: string): Response { return new Response(null, {status:303, headers:{Location:path, 'Cache-Control':'no-store'}}); }
function name(component: string): string { return component.split('/').map(s => s.toLowerCase() === 'ui' ? 'UI' : s.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase())).join(' '); }
const ICON = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const BACK = `<svg ${ICON} width="15" height="15"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
const SEARCH = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5l3.2 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
function progress(t: Translation): string {
  return `<div class="translation-progress"><progress value="${Number(t.translated) || 0}" max="${Number(t.total) || 1}" aria-label="Translated strings"></progress><span>${esc(t.translated)} / ${esc(t.total)} translated</span></div>`;
}
/** A link back up one level, as a pack page's "All packs". */
function back(env: Env, component?: string): string {
  return `<p class="crumbs"><a href="${translationLink(env)}${component ? `/${component}` : ''}">${BACK}${component ? esc(name(component)) : 'All projects'}</a></p>`;
}
function pageNumber(url: URL): number { return Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') ?? '1',10) || 1)); }
function pathFor(env: Env, component: string, language: string, all: boolean, p: number): string { return translationLink(env, `${ROOT}/${component}/${encodeURIComponent(language)}?${new URLSearchParams({view: all ? 'all' : 'todo', page:String(p)})}`); }

export async function translateRoute(req: Request, env: Env, user: User | null): Promise<Response> {
  const url = new URL(req.url);
  let path: string;
  try { path = decodeURIComponent(translationPath(env,url) ?? url.pathname.replace(/\/$/, '')); }
  catch { return render(env,user,'Not found','<h1>Translation not found</h1>',404); }
  if (req.method === 'GET' && url.pathname === '/translate.js') return new Response(TRANSLATE_JS, {headers:{'Content-Type':'text/javascript; charset=utf-8'}});
  if (!['GET','POST'].includes(req.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, POST'}});
  if (req.method === 'POST' && req.headers.get('Origin') !== translationSite(env).origin) return new Response('Cross-site request refused', {status:403});
  const available = components(env);
  if (!env.WEBLATE_URL || !available.length) return render(env,user,'Translations','<h1>Translations</h1><p class="muted">Translations aren’t open yet.</p>',503);
  const match = /^\/translate\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_@.-]+))?$/.exec(path);
  const component = match ? `${match[1]}/${match[2]}` : '';
  if ((path !== ROOT && (!match || !available.includes(component))) || (req.method === 'POST' && !match?.[3])) return render(env,user,'Not found',`<h1>Translation not found</h1><a href="${esc(translationLink(env))}">Browse translations</a>`,404);
  if (req.method === 'POST' && !user) return redirect(translationLogin(env,path + url.search));
  let submitted: Record<string, unknown> | undefined;
  if (req.method === 'POST') {
    try { submitted = await boundedBody(req,64000); }
    catch { return render(env,user,'Translation too long','<h1>Translation too long</h1><p>Return to the editor and shorten your translation.</p>',413); }
  }
  try {
    if (path === ROOT) return render(env,user,'Translations',`<h1>Translations</h1><p class="lede">Translate Blockwork into your language. Saved translations are reviewed, then ship in the next release.</p><ul class="translation-list">${available.map(c => `<li><a href="${translationLink(env)}/${c}"><span class="translation-name">${esc(name(c))}</span><span class="muted">The editor’s menus, settings and blocks</span></a></li>`).join('')}</ul><p class="hint">Sign in with your Blockworked account to save. Translations are credited to your public name.</p>`);
    const languages = await translations(env,component);
    if (!match![3]) return render(env,user,name(component),`${back(env)}<h1>${esc(name(component))}</h1><p class="lede">Pick a language. You’ll start with the strings it’s missing.</p><div class="search translation-search">${SEARCH}<input type="search" id="language-search" placeholder="Find a language" aria-label="Find a language" autocomplete="off"></div>${languages.length ? `<ul class="translation-list languages">${languages.map(t => `<li data-language="${esc(t.language.name + ' ' + t.language.code)}"><a href="${translationLink(env)}/${component}/${encodeURIComponent(t.language.code)}"><span class="translation-name">${esc(t.language.name)} <span class="n">${esc(t.language.code)}</span></span>${progress(t)}</a></li>`).join('')}</ul>` : '<p class="empty">No languages yet.</p>'}<p id="language-empty" class="empty" hidden>No languages match.</p>`);
    const language = match![3], t = languages.find(t => t.language.code === language);
    if (!t) throw new WeblateError(404);
    const all = url.searchParams.get('view') === 'all', p = pageNumber(url);
    if (req.method === 'POST') {
      if (!await limit(env,'translation-save',user!.id,120,3600)) return render(env,user,'Save limit reached','<h1>Save limit reached</h1><p>You’ve saved the most translations allowed in an hour. Try again later.</p>',429);
      const data = submitted!;
      const id = String(data.unit ?? '');
      if (!/^[1-9]\d{0,12}$/.test(id)) throw new WeblateError(400);
      const unit = await webRequest<Unit>(env,`/api/units/${id}/`);
      if (!belongsTo(env,unit,component,language)) throw new WeblateError(404);
      const count = formCount(unit,t), target = Array.from({length:count},(_,i) => typeof data[`target_${i}`] === 'string' ? data[`target_${i}`] as string : '');
      if (target.some(v => !v.trim() || v.length > 20000)) return editor(env,user,component,t,unit,all,p,'Fill in every translation form before saving.',target,400);
      if (data.revision !== await snapshot(unit)) return editor(env,user,component,t,unit,all,p,'This string changed while you were editing. Your draft is below; compare it with the current translation before saving again.',target,409,true);
      try { await webRequest<Unit>(env,`/api/units/${id}/`,{target,state:20},user!); }
      catch (error) {
        if (!(error instanceof WeblateError)) throw error;
        return editor(env,user,component,t,unit,all,p,error.status === 400 ? 'Weblate could not accept this translation. Check placeholders, plural forms, and length, then try again.' : error.status === 403 ? 'This string is locked or your account does not have permission to edit it.' : 'Your translation could not be confirmed as saved. Your draft is below. Try again in a moment.',target,error.status);
      }
      return redirect(pathFor(env,component,language,all,all ? p+1 : p) + '&saved=1');
    }
    const query = new URLSearchParams({page_size:'1',page:String(p),q: all ? 'NOT is:read-only' : 'state:<translated AND NOT is:read-only'});
    let data: {results:Unit[];count:number;next:string|null};
    try { data = await webRequest(env,`/api/translations/${component}/${encodeURIComponent(language)}/units/?${query}`); }
    catch (error) { if (error instanceof WeblateError && error.status === 404 && p>1) data = {results:[],count:0,next:null}; else throw error; }
    const unit = data.results[0];
    if (!unit) return render(env,user,'All caught up',`${back(env,component)}${url.searchParams.get('saved') === '1' ? '<p class="translation-notice" role="status">Translation saved.</p>' : ''}<h1>${p>1 ? 'End of the list' : all ? 'No strings to show' : 'All caught up'}</h1><p class="muted">${p>1 ? `You’ve been through every string in this view. Anything you skipped is still waiting.` : all ? 'There are no strings in this view right now.' : `Nothing in ${esc(t.language.name)} needs a translation right now.`}</p>${progress(t)}<div class="translation-actions"><a class="button primary" href="${pathFor(env,component,language,false,1)}">Check remaining strings</a><a class="button" href="${pathFor(env,component,language,true,1)}">Review all strings</a><a href="${translationLink(env)}/${component}">Other languages</a></div>`);
    return editor(env,user,component,t,unit,all,p,url.searchParams.get('saved') === '1' ? 'Translation saved.' : '');
  } catch (error) {
    if (!(error instanceof WeblateError)) throw error;
    if (submitted && (error.status >= 500 || error.status === 429)) {
      const targets = Object.entries(submitted).filter(([key,value]) => /^target_\d{1,2}$/.test(key) && typeof value === 'string').sort(([a],[b]) => Number(a.slice(7))-Number(b.slice(7)));
      return render(env,user,'Your translation draft',`<h1>Your translation may not have saved</h1><p class="risky" role="alert">The translation service is unavailable. Your draft is below; try again in a moment.</p><form method="post" id="translation-form" data-draft="true"><input type="hidden" name="unit" value="${esc(submitted.unit)}"><input type="hidden" name="revision" value="${esc(submitted.revision)}"><section class="translation-target"><h2>Your draft</h2>${targets.map(([key,value],i) => `<label for="${key}">Translation form ${i+1}</label><textarea id="${key}" name="${key}" dir="auto" rows="4" required maxlength="20000">${esc(value)}</textarea>`).join('')}</section><div class="translation-actions"><button class="primary large" type="submit">Try saving again</button></div></form>`,error.status);
    }
    return render(env,user,'Translations unavailable',`<h1>${error.status === 404 ? 'Translation not found' : 'Translations are temporarily unavailable'}</h1><p class="muted">${error.status === 404 ? 'Choose a project and language to continue.' : 'Please try again in a moment.'}</p><a href="${translationLink(env)}">Browse translations</a>`,error.status);
  }
}
function formCount(unit: Unit, t: Translation): number { return unit.source.length > 1 ? Math.max(1,t.language.plural.number) : 1; }
async function editor(env: Env, user: User | null, component: string, t: Translation, unit: Unit, all: boolean, p: number, notice = '', draft?: string[], status = 200, conflict = false): Promise<Response> {
  const path = pathFor(env,component,t.language.code,all,p), count = formCount(unit,t), source = unit.source;
  const writable = !!env.WEBLATE_SHARED_SECRET && env.WEBLATE_SHARED_SECRET.length >= 32;
  return render(env,user,`Translate to ${t.language.name}`,`${back(env,component)}<h1>${esc(t.language.name)}</h1>${progress(t)}<nav class="translation-tabs" aria-label="String filter"><a href="${pathFor(env,component,t.language.code,false,1)}" ${!all ? 'aria-current="page"' : ''}>Needs translation</a><a href="${pathFor(env,component,t.language.code,true,1)}" ${all ? 'aria-current="page"' : ''}>All strings</a></nav>
    ${notice ? `<p class="${status>=400 ? 'risky' : 'translation-notice'}" role="${status>=400 ? 'alert' : 'status'}">${esc(notice)}</p>` : ''}
    <form method="post" action="${esc(path)}" id="translation-form" data-draft="${draft ? 'true' : 'false'}"><input type="hidden" name="unit" value="${esc(unit.id)}"><input type="hidden" name="revision" value="${await snapshot(unit)}">
    <section class="card translation-source"><h2>English</h2>${source.map((s,i) => `<div>${source.length>1 ? `<p class="muted">${i===0 ? 'Singular' : 'Plural'}</p>` : ''}<p class="translation-text" dir="auto">${esc(s)}</p></div>`).join('')}</section>
    ${unit.context || unit.note || unit.explanation || unit.location ? `<details class="translation-context"><summary>Context and notes</summary>${[unit.context,unit.note,unit.explanation,unit.location].filter(Boolean).map(v=>`<p dir="auto">${esc(v)}</p>`).join('')}</details>` : ''}
    ${unit.has_failing_check ? '<p class="muted">The current translation has checks to resolve. Keep placeholders such as %1, %n, and markup intact.</p>' : ''}
    ${conflict ? `<section class="card"><h2>Current translation</h2>${unit.target.map(v => `<p class="translation-text" dir="auto">${esc(v)}</p>`).join('')}</section>` : ''}
    <section class="translation-target"><h2>Your translation</h2><p class="muted">Keep placeholders and formatting from the original. ${count>1 ? `This language uses ${count} plural forms.` : ''}</p>${Array.from({length:count},(_,i)=>`<label for="target-${i}">${count>1 ? `Plural form ${i+1}` : esc(t.language.name)}</label><textarea id="target-${i}" name="target_${i}" lang="${esc(t.language.code.replace(/_/g,'-'))}" dir="${t.language.direction==='rtl' ? 'rtl' : 'auto'}" rows="4" maxlength="20000" required ${!user || !writable ? 'disabled' : ''}>${esc(draft?.[i] ?? unit.target[i] ?? '')}</textarea>`).join('')}${count>1 ? `<details class="translation-context"><summary>Plural rule</summary><p class="mono">${esc(t.language.plural.formula)}</p><p>Forms follow the order of the language’s Weblate plural rule, starting at form 0.</p></details>` : ''}</section>
    <div class="translation-actions">${user && writable ? '<button class="primary large" type="submit">Save and next</button><span class="muted translation-shortcut"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span>' : user ? '<p class="muted">Saving translations is being set up. Please check back soon.</p>' : `<a class="button primary large" href="${esc(`${new URL(env.SITE_URL).origin}/login?next=${encodeURIComponent(path)}`)}">Sign in with Blockworked to translate</a>`}<a class="translation-skip" href="${pathFor(env,component,t.language.code,all,p+1)}">Skip this string</a></div>
    ${user && writable ? `<p class="muted translation-credit">Credited to ${esc(user.name)}. Saving contributes this translation under ${esc(env.WEBLATE_TRANSLATION_LICENSE || "GPL-3.0-only")}; it becomes available in Blockwork after review and a release.</p>` : ''}</form>` ,status);
}

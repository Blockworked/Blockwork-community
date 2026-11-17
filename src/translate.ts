import { translationSite, translationPath, translationLink, translationLogin } from './translation-site.ts';
import { isAdmin, type User } from './auth.ts';
import { boundedBody, limit } from './account-security.ts';
import { screen } from './moderation.ts';
import type { Env } from './index.ts';
import { esc, page, type Shell } from './pages.ts';
import { t, tn, tp, raw } from './i18n.ts';
import {
  belongsTo, comments, components, glossary, idFrom, otherLanguages, screenshotFile, screenshots, snapshot, suggestions,
  termsIn, translations, webRequest, WeblateError, type Translation, type Unit,
} from './weblate.ts';
import { TRANSLATE_CSS, TRANSLATE_JS } from './translate-ui.ts';
import { PROPOSAL_CSS, proposalAction, proposalForm, proposalsPage, proposeLanguage } from './language-proposals.ts';

const ROOT = '/translate';
function shell(env: Env, user: User | null): Shell {
  return { name: tp('Translations'), href: translationLink(env), site: tp('Blockworked Translations'), place: {community: `${env.SITE_URL}/`, section: 'translations'},
    nav: `<a href="${esc(translationLink(env, `${ROOT}/languages`))}">${t('Languages')}</a>` + (user ? `<a href="${esc(env.SITE_URL)}/account">${t('Account settings')}</a><span class="who">${esc(user.name)}</span>` : `<a href="${esc(translationLogin(env))}">${t('Sign in with Blockworked')}</a>`) };
}
function render(env: Env, user: User | null, title: string, body: string, status = 200): Response {
  const response = page(title, user, isAdmin(env, user), `<style>${TRANSLATE_CSS}${PROPOSAL_CSS}</style><div class="translations">${body}</div><script src="/translate.js" defer></script>`, status, shell(env,user));
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
function redirect(path: string): Response { return new Response(null, {status:303, headers:{Location:path, 'Cache-Control':'no-store'}}); }

/** What each public project is, in the reader's language. */
function project(component: string): {name: string; about: string} {
  const known: Record<string, {name: string; about: string}> = {
    'blockwork/ui': {name: tp('Blockwork app'), about: tp('The editor’s menus, settings and blocks')},
    'blockworked/website': {name: 'blockworked.com', about: tp('The Blockwork website: features, downloads and the changelog')},
    'blockworked/community': {name: tp('Community site'), about: tp('Community blocks, accounts, support and this translation site')},
  };
  return known[component] ?? {name: component.split('/').map(s => s.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase())).join(' '), about: ''};
}

const ICON = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const BACK = `<svg ${ICON} width="15" height="15"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
const SEARCH = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5l3.2 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function progress(done: number, total: number): string {
  return `<div class="translation-progress"><progress value="${Number(done) || 0}" max="${Number(total) || 1}" aria-label="${esc(tp('Translated strings'))}"></progress><span>${t('{done} / {total} translated', {done: Number(done) || 0, total: Number(total) || 0})}</span></div>`;
}
/** A link back up one level, as a pack page's "All packs". */
function back(env: Env, component?: string): string {
  const href = translationLink(env) + (component ? `/${component}` : '');
  const label = component ? esc(project(component).name) : t('All projects');
  return `<p class="crumbs"><a href="${href}">${BACK}${label}</a></p>`;
}

// Which strings the editor walks through. Saving can take a string out of the
// list it came from, so the next one is then at the same position.
const FILTERS = ['todo', 'fuzzy', 'suggestions', 'comments', 'checks', 'translated', 'all'] as const;
type Filter = typeof FILTERS[number];
function filterLabel(f: Filter): string {
  return {todo: tp('Needs translation'), fuzzy: tp('Needs editing'), suggestions: tp('Has suggestions'), comments: tp('Has comments'),
    checks: tp('Failing checks'), translated: tp('Translated'), all: tp('All strings')}[f];
}
const FILTER_QUERY: Record<Filter, string> = {
  todo: 'state:<translated', fuzzy: 'is:needs-editing', suggestions: 'has:suggestion', comments: 'has:comment',
  checks: 'has:check', translated: 'state:>=translated', all: '',
};
interface View { filter: Filter; q: string; page: number }
function viewOf(url: URL): View {
  const legacy = url.searchParams.get('view');
  const asked = url.searchParams.get('filter') ?? (legacy === 'all' ? 'all' : 'todo');
  return {
    filter: (FILTERS as readonly string[]).includes(asked) ? asked as Filter : 'todo',
    q: (url.searchParams.get('q') ?? '').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100),
    page: Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)),
  };
}
function query(v: View): string {
  const parts = [FILTER_QUERY[v.filter], 'NOT is:read-only'].filter(Boolean);
  if (v.q) parts.push(`(source:"${v.q}" OR target:"${v.q}" OR context:"${v.q}" OR note:"${v.q}")`);
  return parts.join(' AND ');
}
function base(env: Env, component: string, language: string, suffix = ''): string {
  return translationLink(env, `${ROOT}/${component}/${encodeURIComponent(language)}${suffix}`);
}
function params(v: View, extra: Record<string, string> = {}): string {
  const p: Record<string, string> = v.filter === 'todo' || v.filter === 'all' ? {view: v.filter} : {filter: v.filter};
  if (v.q) p.q = v.q;
  return '?' + new URLSearchParams({...p, page: String(v.page), ...extra});
}
function pathFor(env: Env, component: string, language: string, v: View, extra: Record<string, string> = {}): string {
  return base(env, component, language) + params(v, extra);
}

function stateMark(unit: Unit): string {
  const [cls, label] = unit.state >= 20 ? ['state-translated', tp('Translated')] : unit.state === 10 ? ['state-editing', tp('Needs editing')] : ['state-off', tp('Not translated')];
  return `<span class="state ${cls}">${esc(label)}</span>`;
}

export async function translateRoute(req: Request, env: Env, user: User | null): Promise<Response> {
  const url = new URL(req.url);
  let path: string;
  try { path = decodeURIComponent(translationPath(env,url) ?? url.pathname.replace(/\/$/, '')); }
  catch { return render(env,user,tp('Not found'),`<h1>${t('Translation not found')}</h1>`,404); }
  if (req.method === 'GET' && url.pathname === '/translate.js') return new Response(TRANSLATE_JS, {headers:{'Content-Type':'text/javascript; charset=utf-8'}});
  if (!['GET','POST'].includes(req.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, POST'}});
  if (req.method === 'POST' && req.headers.get('Origin') !== translationSite(env).origin) return new Response('Cross-site request refused', {status:403});
  const available = components(env);
  if (!env.WEBLATE_URL || !available.length) return render(env,user,tp('Translations'),`<h1>${t('Translations')}</h1><p class="muted">${t('Translations aren’t open yet.')}</p>`,503);
  if (req.method === 'POST' && !user) return redirect(translationLogin(env,path + url.search));
  let submitted: Record<string, unknown> | undefined;
  if (req.method === 'POST') {
    try { submitted = await boundedBody(req,64000); }
    catch { return render(env,user,tp('Translation too long'),`<h1>${t('Translation too long')}</h1><p>${t('Return to the editor and shorten your translation.')}</p>`,413); }
  }
  const view = (title: string, body: string, status = 200) => render(env, user, title, body, status);

  // Language requests and screenshots sit beside the projects.
  const shot = /^\/translate\/screenshots\/([1-9]\d{0,12})$/.exec(path);
  if (shot && req.method === 'GET') {
    try { return await screenshotFile(env, Number(shot[1])); }
    catch (error) { if (error instanceof WeblateError) return new Response('Not found', {status: error.status === 404 ? 404 : 503}); throw error; }
  }
  if (path === `${ROOT}/languages`) {
    if (req.method !== 'GET') return new Response('Method not allowed', {status:405,headers:{Allow:'GET'}});
    const done = url.searchParams.get('done');
    const notice = done === 'proposed' ? tp('Thanks. Your request is listed below, and the team has been told.') : done === 'joined' ? tp('Someone already asked for that language, so you’ve been added to it.') : done === 'added' ? tp('Language added.') : done === 'declined' ? tp('Request declined.') : '';
    return proposalsPage(env, user, isAdmin(env, user), view, notice);
  }
  // Every write here passes the same spam checks as the community site's.
  const refused = async (action: 'language' | 'translation') => {
    if (isAdmin(env, user)) return null;
    const verdict = await screen(env, req, user!, action);
    // A shadowbanned account's translation work isn't sent on.
    const error = !verdict.ok ? verdict.error : verdict.hidden ? tp("That's a lot in a short time. Try again later.") : '';
    return error ? view(tp('Try again later'), `<h1>${t('Try again later')}</h1><p>${esc(error)}</p>`, verdict.ok ? 429 : verdict.status) : null;
  };
  if (path === `${ROOT}/languages/new`) {
    if (req.method === 'POST') return (await refused('language')) ?? proposeLanguage(env, user!, submitted!, view);
    return proposalForm(env, user, view);
  }
  const proposal = /^\/translate\/languages\/([1-9]\d{0,9})$/.exec(path);
  if (proposal && req.method === 'POST') return proposalAction(env, user!, isAdmin(env, user), Number(proposal[1]), submitted!, view);

  const match = /^\/translate\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_@.-]+)(\/strings)?)?$/.exec(path);
  const component = match ? `${match[1]}/${match[2]}` : '';
  if ((path !== ROOT && (!match || !available.includes(component))) || (req.method === 'POST' && (!match?.[3] || match[4]))) return render(env,user,tp('Not found'),`<h1>${t('Translation not found')}</h1><a href="${esc(translationLink(env))}">${t('Browse translations')}</a>`,404);
  try {
    if (path === ROOT) return await projects(env, user, available);
    const languages = await translations(env,component);
    if (!match![3]) return languagePicker(env, user, component, languages);
    const language = match![3], tr = languages.find(t => t.language.code === language);
    if (!tr) throw new WeblateError(404);
    const v = viewOf(url);
    if (match![4]) return await stringList(env, user, component, tr, v);
    if (req.method === 'POST') return (await refused('translation')) ?? await act(env, user!, component, tr, v, submitted!);
    return await editorAt(env, user, component, tr, v, notice(url));
  } catch (error) {
    if (!(error instanceof WeblateError)) throw error;
    if (submitted && (error.status >= 500 || error.status === 429)) {
      const targets = Object.entries(submitted).filter(([key,value]) => /^target_\d{1,2}$/.test(key) && typeof value === 'string').sort(([a],[b]) => Number(a.slice(7))-Number(b.slice(7)));
      return render(env,user,tp('Your translation draft'),`<h1>${t('Your translation may not have saved')}</h1><p class="risky" role="alert">${t('The translation service is unavailable. Your draft is below; try again in a moment.')}</p><form method="post" id="translation-form" data-draft="true"><input type="hidden" name="unit" value="${esc(submitted.unit)}"><input type="hidden" name="revision" value="${esc(submitted.revision)}"><section class="translation-target"><h2>${t('Your draft')}</h2>${targets.map(([key,value],i) => `<label for="${key}">${t('Translation form {n}', {n: i+1})}</label><textarea id="${key}" name="${key}" dir="auto" rows="4" required maxlength="20000">${esc(value)}</textarea>`).join('')}</section><div class="translation-actions"><button class="primary large" type="submit">${t('Try saving again')}</button></div></form>`,error.status);
    }
    return render(env,user,tp('Translations unavailable'),`<h1>${error.status === 404 ? t('Translation not found') : t('Translations are temporarily unavailable')}</h1><p class="muted">${error.status === 404 ? t('Choose a project and language to continue.') : t('Please try again in a moment.')}</p><a href="${esc(translationLink(env))}">${t('Browse translations')}</a>`,error.status);
  }
}

function notice(url: URL): string {
  return {'1': tp('Translation saved.'), editing: tp('Saved and marked as needing editing.'), suggested: tp('Suggestion added. A reviewer can accept it.'),
    voted: tp('Vote counted.'), commented: tp('Comment posted.')}[url.searchParams.get('saved') ?? ''] ?? '';
}

async function projects(env: Env, user: User | null, available: string[]): Promise<Response> {
  const stats = await Promise.allSettled(available.map(c => translations(env, c)));
  if (stats.every(s => s.status === 'rejected')) throw (stats[0] as PromiseRejectedResult).reason;
  const rows = available.map((c, i) => {
    const s = stats[i];
    if (s.status === 'rejected') return '';
    const done = s.value.reduce((n, tr) => n + (Number(tr.translated) || 0), 0), total = s.value.reduce((n, tr) => n + (Number(tr.total) || 0), 0);
    const p = project(c);
    return `<li><a href="${translationLink(env)}/${c}"><span class="translation-name">${esc(p.name)}</span><span class="muted">${esc(p.about)}</span><span class="translation-meta-line">${tn('{n} language', '{n} languages', s.value.length)}${total ? ` · ${t('{percent}% translated overall', {percent: Math.floor(done / total * 100)})}` : ''}</span></a></li>`;
  }).join('');
  return render(env,user,tp('Translations'),`<h1>${t('Translations')}</h1><p class="lede">${t('Translate Blockwork and its websites into your language. Saved translations are reviewed, then ship with the next release.')}</p><ul class="translation-list">${rows}</ul>
    <p>${t('Don’t see your language? {link}', {link: raw(`<a href="${esc(translationLink(env, `${ROOT}/languages/new`))}">${t('Propose a new language')}</a>`)})}</p>
    <p class="hint">${t('Sign in with your Blockworked account to save. Translations are credited to your public name.')}</p>`);
}

function languagePicker(env: Env, user: User | null, component: string, languages: Translation[]): Response {
  const p = project(component);
  return render(env,user,p.name,`${back(env)}<h1>${esc(p.name)}</h1><p class="lede">${t('Pick a language. You’ll start with the strings it’s missing.')}</p><div class="search translation-search">${SEARCH}<input type="search" id="language-search" placeholder="${esc(tp('Find a language'))}" aria-label="${esc(tp('Find a language'))}" autocomplete="off"></div>${languages.length ? `<ul class="translation-list languages">${languages.map(tr => `<li data-language="${esc(tr.language.name + ' ' + tr.language.code)}"><a href="${translationLink(env)}/${component}/${encodeURIComponent(tr.language.code)}"><span class="translation-name">${esc(tr.language.name)} <span class="n">${esc(tr.language.code)}</span></span>${progress(tr.translated, tr.total)}</a></li>`).join('')}</ul>` : `<p class="empty">${t('No languages yet.')}</p>`}<p id="language-empty" class="empty" hidden>${t('No languages match.')}</p>
    <p class="hint">${t('Not listed? {link}', {link: raw(`<a href="${esc(translationLink(env, `${ROOT}/languages/new`))}">${t('Propose a new language')}</a>`)})}</p>`);
}

/** The tabs and search box above both the editor and the list. */
function toolbar(env: Env, component: string, tr: Translation, v: View, list: boolean): string {
  const code = tr.language.code, tabs: Filter[] = ['todo', 'fuzzy', 'all'];
  const at = (f: Filter) => list ? base(env, component, code, '/strings') + params({filter: f, q: v.q, page: 1}) : pathFor(env, component, code, {filter: f, q: v.q, page: 1});
  return `<nav class="translation-tabs" aria-label="${esc(tp('String filter'))}">${tabs.map(f => `<a href="${at(f)}" ${v.filter === f ? 'aria-current="page"' : ''}>${esc(filterLabel(f))}</a>`).join('')}
    <a class="translation-tabs-end" href="${list ? pathFor(env, component, code, {...v, page: 1}) : base(env, component, code, '/strings') + params({...v, page: 1})}">${list ? t('Translate one by one') : t('List and search')}</a></nav>
    <form class="translation-find" method="get" action="${base(env, component, code, '/strings')}" role="search">
      <div class="search">${SEARCH}<input type="search" name="q" value="${esc(v.q)}" placeholder="${esc(tp('Search the English text, translations and context'))}" aria-label="${esc(tp('Search strings'))}" autocomplete="off"></div>
      <select name="filter" aria-label="${esc(tp('Show'))}">${FILTERS.map(f => `<option value="${f}"${f === v.filter ? ' selected' : ''}>${esc(filterLabel(f))}</option>`).join('')}</select>
      <button type="submit">${t('Search')}</button>
    </form>`;
}

async function units(env: Env, component: string, language: string, v: View, size: number, page: number): Promise<{results: Unit[]; count: number}> {
  try { return await webRequest(env, `/api/translations/${component}/${encodeURIComponent(language)}/units/?${new URLSearchParams({page_size: String(size), page: String(page), q: query(v)})}`); }
  catch (error) { if (error instanceof WeblateError && error.status === 404 && page > 1) return {results: [], count: 0}; throw error; }
}

const PAGE = 50;
async function stringList(env: Env, user: User | null, component: string, tr: Translation, v: View): Promise<Response> {
  const data = await units(env, component, tr.language.code, v, PAGE, v.page);
  const first = (v.page - 1) * PAGE, pages = Math.max(1, Math.ceil(data.count / PAGE));
  const rows = data.results.map((u, i) => `<li><a href="${pathFor(env, component, tr.language.code, {...v, page: first + i + 1})}">
    <span class="string-source" dir="auto">${esc(u.source[0])}</span>
    <span class="string-target" dir="${tr.language.direction === 'rtl' ? 'rtl' : 'auto'}" lang="${esc(tr.language.code.replace(/_/g, '-'))}">${u.target[0] ? esc(u.target[0]) : `<span class="muted">${t('Not translated yet')}</span>`}</span>
    <span class="string-state">${stateMark(u)}${u.has_suggestion ? `<span class="string-flag">${t('Suggestion')}</span>` : ''}${u.has_comment ? `<span class="string-flag">${t('Comment')}</span>` : ''}${u.has_failing_check ? `<span class="string-flag">${t('Check')}</span>` : ''}</span></a></li>`).join('');
  const nav = pages > 1 ? `<nav class="translation-pages" aria-label="${esc(tp('Pages'))}">${v.page > 1 ? `<a href="${base(env, component, tr.language.code, '/strings') + params({...v, page: v.page - 1})}">${t('Previous')}</a>` : '<span></span>'}<span class="muted">${t('Page {page} of {pages}', {page: v.page, pages})}</span>${v.page < pages ? `<a href="${base(env, component, tr.language.code, '/strings') + params({...v, page: v.page + 1})}">${t('Next')}</a>` : '<span></span>'}</nav>` : '';
  return render(env, user, tp('{language} strings', {language: tr.language.name}), `${back(env, component)}<h1>${esc(tr.language.name)}</h1>${progress(tr.translated, tr.total)}${toolbar(env, component, tr, v, true)}
    <p class="hint">${tn('{n} string', '{n} strings', data.count)}${v.q ? ` · ${t('matching “{q}”', {q: v.q})}` : ''}</p>
    ${rows ? `<ul class="translation-list strings">${rows}</ul>` : `<p class="empty">${v.q ? t('No strings match.') : t('No strings in this view.')}</p>`}${nav}`);
}

async function editorAt(env: Env, user: User | null, component: string, tr: Translation, v: View, message: string): Promise<Response> {
  const data = await units(env, component, tr.language.code, v, 1, v.page);
  const unit = data.results[0];
  if (!unit) {
    return render(env,user,tp('All caught up'),`${back(env,component)}${message ? `<p class="translation-notice" role="status">${esc(message)}</p>` : ''}<h1>${v.page>1 ? t('End of the list') : v.filter === 'todo' && !v.q ? t('All caught up') : t('No strings to show')}</h1><p class="muted">${v.page>1 ? t('You’ve been through every string in this view. Anything you skipped is still waiting.') : v.filter === 'todo' && !v.q ? t('Nothing in {language} needs a translation right now.', {language: tr.language.name}) : t('There are no strings in this view right now.')}</p>${progress(tr.translated, tr.total)}<div class="translation-actions"><a class="button primary" href="${pathFor(env,component,tr.language.code,{filter:'todo',q:'',page:1})}">${t('Check remaining strings')}</a><a class="button" href="${pathFor(env,component,tr.language.code,{filter:'all',q:'',page:1})}">${t('Review all strings')}</a><a href="${translationLink(env)}/${component}">${t('Other languages')}</a></div>`);
  }
  return editor(env,user,component,tr,unit,v,data.count,message);
}

function formCount(unit: Unit, tr: Translation): number { return unit.source.length > 1 ? Math.max(1,tr.language.plural.number) : 1; }

// Placeholders a translation has to keep: printf and Qt (%1, %n, %s, %1$s),
// braces ({name}, {0}) and markup tags.
const PLACEHOLDER = /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[sdifuxXeEgGcpn%]|%L?\d{1,2}|%n|\{[A-Za-z0-9_]*\}|<\/?[a-zA-Z][^<>]*>/g;
function placeholders(source: string[]): string[] {
  return [...new Set(source.flatMap(s => s.match(PLACEHOLDER) ?? []).filter(p => p !== '%%'))];
}
function marked(text: string): string {
  let out = '', at = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += esc(text.slice(at, m.index)) + `<button type="button" class="ph" data-insert="${esc(m[0])}" title="${esc(tp('Insert {placeholder}', {placeholder: m[0]}))}">${esc(m[0])}</button>`;
    at = m.index! + m[0].length;
  }
  return out + esc(text.slice(at));
}

/** Calls that only add to the page; a failure leaves that part out. */
async function extras(env: Env, component: string, tr: Translation, unit: Unit) {
  const settle = async <T>(p: Promise<T>, empty: T): Promise<T> => {
    try { return await p; } catch (error) { if (error instanceof WeblateError) return empty; throw error; }
  };
  const [others, suggested, said, shots, terms] = await Promise.all([
    settle(otherLanguages(env, unit), []),
    unit.has_suggestion === false ? Promise.resolve([]) : settle(suggestions(env, unit.id), []),
    unit.has_comment === false ? Promise.resolve([]) : settle(comments(env, unit.id), []),
    settle(screenshots(env, unit), []),
    settle(glossary(env, component, tr.language.code), []),
  ]);
  return {others, suggested, said, shots, terms: termsIn(unit.source.join('\n'), terms)};
}

async function editor(env: Env, user: User | null, component: string, tr: Translation, unit: Unit, v: View, count: number, notice = '', draft?: string[], status = 200, conflict = false): Promise<Response> {
  const code = tr.language.code, path = pathFor(env,component,code,v), forms = formCount(unit,tr), source = unit.source;
  const writable = !!env.WEBLATE_SHARED_SECRET && env.WEBLATE_SHARED_SECRET.length >= 32;
  const can = !!user && writable;
  const {others, suggested, said, shots, terms} = await extras(env, component, tr, unit);
  const names = new Map((await translations(env, component).catch(() => [] as Translation[])).map(x => [x.language.code, x.language.name]));
  const lang = esc(code.replace(/_/g,'-').replace(/@.*/, '')), dir = tr.language.direction==='rtl' ? 'rtl' : 'auto';
  const meta = [[tp('Context'), unit.context], [tp('Note'), unit.note], [tp('Explanation'), unit.explanation], [tp('Where it appears'), unit.location]].filter(([, value]) => value);
  const hidden = `<input type="hidden" name="unit" value="${esc(unit.id)}"><input type="hidden" name="revision" value="${await snapshot(unit)}">`;
  const signin = `${new URL(env.SITE_URL).origin}/login?next=${encodeURIComponent(path)}`;

  const sections: string[] = [];
  if (shots.length) sections.push(`<section class="translation-panel"><h2>${t('Screenshots')}</h2><div class="translation-shots">${shots.map(s => `<a href="${esc(translationLink(env, `${ROOT}/screenshots/${s.id}`))}" target="_blank" rel="noopener"><img src="${esc(translationLink(env, `${ROOT}/screenshots/${s.id}`))}" alt="${esc(s.name)}" loading="lazy"></a>`).join('')}</div></section>`);
  if (suggested.length) sections.push(`<section class="translation-panel"><h2>${t('Suggestions')}</h2><ul class="translation-rows">${suggested.map(s => `<li><p class="translation-text" dir="${dir}" lang="${lang}">${s.target.map(esc).join('<br>')}</p><div class="row-actions"><span class="muted">${tn('{n} vote', '{n} votes', s.votes || 0)}</span>${can ? `<button type="button" class="ghost" data-fill="${esc(JSON.stringify(s.target))}">${t('Use this')}</button><form method="post" action="${esc(path)}" class="inline">${hidden}<input type="hidden" name="action" value="vote"><input type="hidden" name="suggestion" value="${esc(s.id)}"><button type="submit">${t('Vote')}</button></form>` : ''}</div></li>`).join('')}</ul></section>`);
  if (others.length) sections.push(`<section class="translation-panel"><details${others.length <= 4 ? ' open' : ''}><summary><h2>${t('In other languages')} <span class="n">${others.length}</span></h2></summary><ul class="translation-rows other-languages">${others.slice(0, 60).map(o => `<li><span class="muted">${esc(names.get(o.language_code ?? '') ?? languageName(o.language_code ?? ''))}</span><span dir="auto" lang="${esc((o.language_code ?? '').replace(/_/g,'-').replace(/@.*/, ''))}">${esc(o.target[0])}</span></li>`).join('')}</ul></details></section>`);
  sections.push(`<section class="translation-panel" id="comments"><h2>${t('Comments')}${said.length ? ` <span class="n">${said.length}</span>` : ''}</h2>${said.length ? `<ul class="translation-rows">${said.map(c => `<li><p dir="auto" class="comment-text">${esc(c.comment)}</p><time class="muted" datetime="${esc(c.timestamp)}">${esc(new Date(c.timestamp).toISOString().slice(0, 10))}</time></li>`).join('')}</ul>` : `<p class="muted">${t('Ask about this string, or tell others what you know about it.')}</p>`}
    ${can ? `<form method="post" action="${esc(path)}#comments" class="comment-form">${hidden}<input type="hidden" name="action" value="comment"><label for="comment">${t('Add a comment')}</label><textarea id="comment" name="comment" rows="2" maxlength="1000" required dir="auto"></textarea><div class="translation-actions"><select name="scope" aria-label="${esc(tp('About'))}"><option value="translation">${t('About this translation')}</option><option value="global">${t('About this string in every language')}</option><option value="report">${t('The English text has a problem')}</option></select><button type="submit">${t('Post comment')}</button></div></form>` : ''}</section>`);

  const position = count ? `<p class="translation-position muted">${t('String {n} of {count}', {n: v.page, count})}${v.q ? ` · ${t('matching “{q}”', {q: v.q})}` : ''}</p>` : '';
  return render(env,user,tp('Translate to {language}', {language: tr.language.name}),`${back(env,component)}<h1>${esc(tr.language.name)}</h1>${progress(tr.translated, tr.total)}${toolbar(env, component, tr, v, false)}
    ${notice ? `<p class="${status>=400 ? 'risky' : 'translation-notice'}" role="${status>=400 ? 'alert' : 'status'}">${esc(notice)}</p>` : ''}
    <div class="translation-step">${position}<nav class="translation-step-links">${v.page > 1 ? `<a href="${pathFor(env,component,code,{...v,page:v.page-1})}" rel="prev">${t('Previous')}</a>` : ''}<a class="translation-skip" href="${pathFor(env,component,code,{...v,page:v.page+1})}" rel="next">${t('Skip this string')}</a></nav></div>
    <form method="post" action="${esc(path)}" id="translation-form" data-draft="${draft ? 'true' : 'false'}" data-placeholders="${esc(JSON.stringify(placeholders(source)))}">${hidden}
    <section class="card translation-source"><div class="translation-source-head"><h2>${t('English')}</h2>${can ? `<button type="button" class="ghost" data-copy-source="${esc(JSON.stringify(source))}">${t('Copy English')}</button>` : ''}</div>${source.map((s,i) => `<div>${source.length>1 ? `<p class="muted">${i===0 ? t('Singular') : t('Plural')}</p>` : ''}<p class="translation-text" dir="auto">${marked(s)}</p></div>`).join('')}
    ${unit.previous_source && unit.state === 10 ? `<p class="translation-changed">${t('The English text changed. It used to say: {text}', {text: unit.previous_source})}</p>` : ''}</section>
    ${meta.length ? `<dl class="translation-meta">${meta.map(([k, value]) => `<dt>${esc(k)}</dt><dd dir="auto">${esc(value)}</dd>`).join('')}</dl>` : ''}
    ${terms.length ? `<section class="translation-glossary"><h2>${t('Glossary')}</h2><dl>${terms.map(term => `<dt dir="auto">${esc(term.source)}</dt><dd dir="${dir}" lang="${lang}">${term.target ? esc(term.target) : `<span class="muted">${t('No agreed translation yet')}</span>`}${term.note ? `<span class="muted"> · ${esc(term.note)}</span>` : ''}</dd>`).join('')}</dl></section>` : ''}
    ${unit.has_failing_check ? `<p class="muted">${t('The current translation has checks to resolve. Keep placeholders such as %1, %n, and markup intact.')}</p>` : ''}
    ${conflict ? `<section class="card"><h2>${t('Current translation')}</h2>${unit.target.map(value => `<p class="translation-text" dir="auto">${esc(value)}</p>`).join('')}</section>` : ''}
    <section class="translation-target"><h2>${t('Your translation')}</h2><p class="muted">${t('Keep placeholders and formatting from the original.')} ${forms>1 ? t('This language uses {n} plural forms.', {n: forms}) : ''}</p>${Array.from({length:forms},(_,i)=>`<label for="target-${i}">${forms>1 ? t('Plural form {n}', {n: i+1}) : esc(tr.language.name)}</label><textarea id="target-${i}" name="target_${i}" lang="${lang}" dir="${dir}" rows="4" maxlength="20000" required ${can ? '' : 'disabled'}>${esc(draft?.[i] ?? unit.target[i] ?? '')}</textarea>`).join('')}
    <p class="translation-warning" id="placeholder-warning" role="status" data-label="${esc(tp('Missing from your translation:'))}" hidden></p>
    ${forms>1 ? `<details class="translation-context"><summary>${t('Plural rule')}</summary><p class="mono">${esc(tr.language.plural.formula)}</p><p>${t('Forms follow the order of the language’s plural rule, starting at form 0.')}</p></details>` : ''}
    ${can ? `<label class="translation-check"><input type="checkbox" name="needs_editing" value="1"${unit.state === 10 ? ' checked' : ''}> ${t('Not sure? Mark it as needing editing so someone checks it')}</label>` : ''}</section>
    <div class="translation-actions">${can ? `<button class="primary large" type="submit" name="action" value="save">${t('Save and next')}</button><button class="large" type="submit" name="action" value="suggest">${t('Suggest instead')}</button><span class="muted translation-shortcut">${t('{keys} saves', {keys: raw('<kbd>Ctrl</kbd> + <kbd>Enter</kbd>')})}</span>` : user ? `<p class="muted">${t('Saving translations is being set up. Please check back soon.')}</p>` : `<a class="button primary large" href="${esc(signin)}">${t('Sign in with Blockworked to translate')}</a>`}</div>
    ${can ? `<p class="muted translation-credit">${t('Credited to {name}. Saving contributes this translation under {license}; it ships after review and a release.', {name: user!.name, license: env.WEBLATE_TRANSLATION_LICENSE || 'GPL-3.0-only'})}</p>` : ''}</form>
    ${sections.join('')}`, status);
}

/** Save, suggest, vote or comment, then go on. */
async function act(env: Env, user: User, component: string, tr: Translation, v: View, data: Record<string, unknown>): Promise<Response> {
  const language = tr.language.code;
  const id = String(data.unit ?? '');
  if (!/^[1-9]\d{0,12}$/.test(id)) throw new WeblateError(400);
  const action = String(data.action ?? 'save');
  if (!['save', 'suggest', 'vote', 'comment'].includes(action)) throw new WeblateError(400);
  if (!await limit(env,'translation-save',user.id,120,3600)) return render(env,user,tp('Save limit reached'),`<h1>${t('Save limit reached')}</h1><p>${t('You’ve saved the most translations allowed in an hour. Try again later.')}</p>`,429);
  const unit = await webRequest<Unit>(env,`/api/units/${id}/`);
  if (!belongsTo(env,unit,component,language)) throw new WeblateError(404);
  const again = (message: string, status: number, draft?: string[], conflict = false) => editor(env,user,component,tr,unit,v,0,message,draft,status,conflict);
  const sorry = (error: unknown, draft?: string[]) => {
    if (!(error instanceof WeblateError)) throw error;
    return again(error.status === 400 ? tp('Weblate could not accept this. Check placeholders, plural forms, and length, then try again.') : error.status === 403 ? tp('This string is locked or your account does not have permission to do that.') : tp('This could not be confirmed as saved. Your draft is below. Try again in a moment.'), error.status, draft);
  };

  if (action === 'comment') {
    const text = String(data.comment ?? '').trim(), scope = String(data.scope ?? 'translation');
    if (!text || text.length > 1000 || !['translation', 'global', 'report'].includes(scope)) return again(tp('Write a comment of up to 1000 characters.'), 400);
    try { await webRequest(env, `/api/units/${id}/comments/`, {scope, comment: text}, user, 'POST'); } catch (error) { return sorry(error); }
    return redirect(pathFor(env, component, language, v, {saved: 'commented'}) + '#comments');
  }
  if (action === 'vote') {
    const which = Number(data.suggestion);
    const suggestion = (await suggestions(env, unit.id)).find(s => s.id === which && idFrom(env, s.unit, 'units') === unit.id);
    if (!suggestion) return again(tp('That suggestion is gone. It may have been accepted or removed.'), 409);
    try { await webRequest(env, `/api/units/${id}/suggestions/`, {target: suggestion.target}, user, 'POST'); } catch (error) { return sorry(error); }
    return redirect(pathFor(env, component, language, v, {saved: 'voted'}));
  }

  const forms = formCount(unit,tr), target = Array.from({length:forms},(_,i) => typeof data[`target_${i}`] === 'string' ? data[`target_${i}`] as string : '');
  if (target.some(value => !value.trim() || value.length > 20000)) return again(tp('Fill in every translation form before saving.'), 400, target);
  if (action === 'suggest') {
    try { await webRequest(env, `/api/units/${id}/suggestions/`, {target}, user, 'POST'); } catch (error) { return sorry(error, target); }
    return redirect(pathFor(env, component, language, {...v, page: v.page + 1}, {saved: 'suggested'}));
  }
  if (data.revision !== await snapshot(unit)) return again(tp('This string changed while you were editing. Your draft is below; compare it with the current translation before saving again.'), 409, target, true);
  const state = data.needs_editing ? 10 : 20;
  try { await webRequest<Unit>(env,`/api/units/${id}/`,{target,state},user); } catch (error) { return sorry(error, target); }
  // A string that leaves the list it was in leaves the next one where it was.
  const leaves = (v.filter === 'todo' && state === 20) || (v.filter === 'fuzzy' && state === 20) || (v.filter === 'translated' && state === 10);
  return redirect(pathFor(env, component, language, {...v, page: leaves ? v.page : v.page + 1}, {saved: state === 10 ? 'editing' : '1'}));
}

/** A language's English name from its Weblate code, for languages the component list didn't name. */
function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], {type: 'language'}).of(code.replace(/_/g, '-').replace(/@.*/, '')) ?? code; } catch { return code; }
}

// Languages people ask for, per translation project. Anyone signed in can
// propose one or say they will help; an admin adds it to the project or declines it.
import type { User } from './auth.ts';
import type { Env } from './index.ts';
import { esc } from './pages.ts';
import { t, tn, tp } from './i18n.ts';
import { limit } from './account-security.ts';
import { notify } from './notifications.ts';
import { addLanguage, translations, WeblateError } from './weblate.ts';
import { translationLink } from './translation-site.ts';
import { LANGUAGES } from './language-catalog.ts';

interface Proposal {
  id: number; code: string; name: string; note: string; status: 'open' | 'added' | 'declined'; reply: string;
  created_at: number; supporters: number; mine: number; author: string | null;
}
export type Render = (title: string, body: string, status?: number) => Response;
/** The project a request belongs to: its Weblate component and the name readers know it by. */
export interface Project { component: string; name: string }
const home = (env: Env, p: Project, suffix = '') => translationLink(env, `/translate/${p.component}/languages${suffix}`);

const CODE = /^[a-z]{2,3}(?:_[A-Z][a-z]{3})?(?:_[A-Z]{2}|_\d{3})?(?:@[a-z]{2,10})?$/;
/** pt-br, PT_BR and pt_BR all become Weblate's pt_BR. */
export function normalizeCode(code: string): string {
  const parts = code.trim().replace(/-/g, '_').split('_');
  return parts.map((p, i) => i === 0 ? p.toLowerCase() : p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()).join('_');
}

async function load(env: Env, user: User | null, project: Project): Promise<Proposal[]> {
  const rows = await env.DB.prepare(`SELECT p.id, p.code, p.name, p.note, p.status, p.reply, p.created_at, u.name AS author,
      (SELECT COUNT(*) FROM language_supporters s WHERE s.proposal_id = p.id) AS supporters,
      EXISTS (SELECT 1 FROM language_supporters s WHERE s.proposal_id = p.id AND s.user_id = ?) AS mine
    FROM language_proposals p LEFT JOIN users u ON u.id = p.user_id WHERE p.component = ?
    ORDER BY p.status = 'open' DESC, supporters DESC, p.created_at DESC LIMIT 200`).bind(user?.id ?? '', project.component).all<Proposal>();
  return rows.results;
}

function form(env: Env, admin: boolean, project: Project, p: Proposal): string {
  const action = home(env, project, `/${p.id}`);
  if (p.status !== 'open') return '';
  const help = `<form method="post" action="${esc(action)}" class="inline"><input type="hidden" name="action" value="${p.mine ? 'withdraw' : 'support'}"><button type="submit"${p.mine ? ' aria-pressed="true"' : ''}>${p.mine ? t('You’ll help') : t('I’ll help translate')}</button></form>`;
  const review = admin ? `<details class="proposal-review"><summary>${t('Review')}</summary><form method="post" action="${esc(action)}">
    <label>${t('Weblate language code')}<br><input type="text" name="code" value="${esc(p.code)}" maxlength="20" required pattern="[A-Za-z_@-]{2,20}"></label>
    <label>${t('Reply to the people who asked (optional)')}<br><textarea name="reply" rows="2" maxlength="500"></textarea></label>
    <div class="translation-actions"><button class="primary" type="submit" name="action" value="add">${t('Add to {project}', {project: project.name})}</button><button type="submit" name="action" value="decline">${t('Decline')}</button></div></form></details>` : '';
  return help + review;
}

function status(p: Proposal): string {
  if (p.status === 'added') return `<span class="state state-done">${t('Added')}</span>`;
  if (p.status === 'declined') return `<span class="state state-off">${t('Not added')}</span>`;
  return `<span class="state state-open">${tn('{n} person will help', '{n} people will help', p.supporters)}</span>`;
}

export async function proposalsPage(env: Env, user: User | null, admin: boolean, project: Project, render: Render, notice = ''): Promise<Response> {
  const list = await load(env, user, project);
  const rows = list.map(p => `<li class="proposal" id="language-${p.id}"><div class="proposal-head"><span class="translation-name" lang="${esc(p.code.replace(/_/g, '-').replace(/@.*/, ''))}">${esc(p.name)} <span class="n">${esc(p.code)}</span></span>${status(p)}</div>
    ${p.note ? `<p class="proposal-note" dir="auto">${esc(p.note)}</p>` : ''}${p.reply ? `<p class="proposal-note muted" dir="auto">${t('Reply: {text}', {text: p.reply})}</p>` : ''}
    <p class="hint">${p.author ? t('Asked by {name}', {name: p.author}) : t('Asked by a former member')}</p>${user ? form(env, admin, project, p) : ''}</li>`).join('');
  return render(tp('Languages people asked for'), `<p class="crumbs"><a href="${esc(translationLink(env, `/translate/${project.component}`))}">${BACK}${esc(project.name)}</a></p>
    <h1>${t('Languages people asked for')}</h1>
    <p class="lede">${t('Requests to translate {project}. When a few people say they’ll help, the language is added and you can start translating.', {project: project.name})}</p>
    ${notice ? `<p class="translation-notice" role="status">${esc(notice)}</p>` : ''}
    <p><a class="button primary" href="${esc(home(env, project, '/new'))}">${t('Propose a language')}</a></p>
    ${rows ? `<ul class="translation-list proposals">${rows}</ul>` : `<p class="empty">${t('Nobody has asked for a language yet.')}</p>`}
    ${user ? '' : `<p class="hint">${t('Sign in with your Blockworked account to propose a language or say you’ll help.')}</p>`}`);
}

/** The picker's data: Weblate's languages, plus which are open or already asked for. */
async function pickerData(env: Env, project: Project): Promise<string> {
  const [open, asked] = await Promise.all([
    openLanguages(env, project).catch(() => new Map<string, string>()),
    env.DB.prepare(`SELECT code FROM language_proposals WHERE status = 'open' AND component = ?`).bind(project.component).all<{code: string}>().then(r => r.results.map(p => p.code.toLowerCase())).catch(() => [] as string[]),
  ]);
  const links = Object.fromEntries([...open].map(([key, code]) => [key, `${translationLink(env)}/${project.component}/${encodeURIComponent(code)}`]));
  // Inside a script element, so nothing may close it.
  return JSON.stringify({languages: LANGUAGES, open: links, asked}).replace(/</g, '\\u003c');
}

export async function proposalForm(env: Env, user: User | null, project: Project, render: Render, error = '', draft: Record<string, unknown> = {}, statusCode = 200): Promise<Response> {
  const value = (k: string) => esc(typeof draft[k] === 'string' ? draft[k] : '');
  const signin = `${new URL(env.SITE_URL).origin}/login?next=${encodeURIComponent(home(env, project, '/new'))}`;
  return render(tp('Propose a language for {project}', {project: project.name}), `<p class="crumbs"><a href="${esc(home(env, project))}">${BACK}${t('Languages people asked for')}</a></p>
    <h1>${t('Propose a language for {project}', {project: project.name})}</h1>
    <p class="lede">${t('Ask for a language {project} isn’t open in yet. It’s added once a few people say they’ll help translate it.', {project: project.name})}</p>
    ${error ? `<p class="risky" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="${esc(home(env, project, '/new'))}" class="proposal-form">
      <div class="field"><label for="language-name">${t('Language')}</label><div class="language-combo"><input id="language-name" type="text" name="name" required maxlength="60" value="${value('name')}" placeholder="${esc(tp('Search by name, in English or in the language, or by code'))}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="language-options"><ul id="language-options" class="language-options" role="listbox" aria-label="${esc(tp('Languages'))}" hidden
        data-open="${esc(tp('Already open'))}" data-asked="${esc(tp('Already asked for'))}" data-none="${esc(tp('No language matches. You can still propose it by that name.'))}"></ul></div>
        <p id="language-picked" class="language-picked hint" aria-live="polite" hidden data-open="${esc(tp('{name} is already open for translation.'))}" data-translate="${esc(tp('Translate it'))}" data-asked="${esc(tp('Someone already asked for {name}. Proposing it adds you to that request.'))}"></p></div>
      <div class="field"><label for="language-code">${t('Language code')}</label><input id="language-code" type="text" name="code" maxlength="20" value="${value('code')}" placeholder="pt_BR" autocomplete="off" spellcheck="false"><span class="hint">${t('Filled in when you pick a language from the list. Leave it empty if you’re not sure.')}</span></div>
      <div class="field"><label for="language-note">${t('Anything we should know (optional)')}</label><textarea id="language-note" name="note" rows="3" maxlength="500" dir="auto">${value('note')}</textarea></div>
      <div class="translation-actions">${user ? `<button class="primary large" type="submit">${t('Propose it')}</button>` : `<a class="button primary large" href="${esc(signin)}">${t('Sign in with Blockworked to propose')}</a>`}</div>
    </form>
    <script type="application/json" id="language-catalog">${await pickerData(env, project)}</script>`, statusCode);
}

/** The project's open languages: lowercased code to Weblate's code. */
async function openLanguages(env: Env, project: Project): Promise<Map<string, string>> {
  return new Map((await translations(env, project.component)).map(tr => [tr.language.code.toLowerCase(), tr.language.code]));
}

export async function proposeLanguage(env: Env, user: User, project: Project, data: Record<string, unknown>, render: Render): Promise<Response> {
  const name = String(data.name ?? '').trim().replace(/\s+/g, ' '), note = String(data.note ?? '').trim();
  const code = normalizeCode(String(data.code ?? '') || '');
  if (!name || name.length > 60) return proposalForm(env, user, project, render, tp('Name the language, in up to 60 characters.'), data, 400);
  if (note.length > 500) return proposalForm(env, user, project, render, tp('Keep the note under 500 characters.'), data, 400);
  if (code && !CODE.test(code)) return proposalForm(env, user, project, render, tp('That doesn’t look like a language code. Leave it empty if you’re not sure.'), data, 400);
  const open = await openLanguages(env, project).catch(() => new Map<string, string>());
  if (code && open.has(code.toLowerCase())) return proposalForm(env, user, project, render, tp('{name} is already open in {project}. Pick it from the project’s language list.', {name, project: project.name}), data, 409);
  if (!await limit(env, 'language-proposal', user.id, 5, 86400)) return proposalForm(env, user, project, render, tp('You’ve proposed the most languages allowed in a day. Try again tomorrow.'), data, 429);
  const existing = code ? await env.DB.prepare(`SELECT id FROM language_proposals WHERE component = ? AND lower(code) = lower(?) AND status = 'open'`).bind(project.component, code).first<{id: number}>() : null;
  if (existing) {
    await env.DB.prepare('INSERT OR IGNORE INTO language_supporters (proposal_id, user_id, created_at) VALUES (?, ?, ?)').bind(existing.id, user.id, Date.now()).run();
    return redirect(home(env, project) + `?done=joined#language-${existing.id}`);
  }
  const row = await env.DB.prepare(`INSERT INTO language_proposals (component, code, name, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(project.component, code || name.toLowerCase().replace(/[^a-z]+/g, '_').slice(0, 20), name, note, user.id, Date.now()).first<{id: number}>();
  await env.DB.prepare('INSERT INTO language_supporters (proposal_id, user_id, created_at) VALUES (?, ?, ?)').bind(row!.id, user.id, Date.now()).run();
  await notify(env, {title: `Language proposed for ${project.name}: ${name}`, text: `${user.name} asked for ${name}${code ? ` (${code})` : ''} in ${project.name}.${note ? `\n\n${note}` : ''}`, url: new URL(home(env, project), env.SITE_URL).href});
  return redirect(home(env, project) + `?done=proposed#language-${row!.id}`);
}

export async function proposalAction(env: Env, user: User, admin: boolean, project: Project, id: number, data: Record<string, unknown>, render: Render): Promise<Response> {
  const proposal = await env.DB.prepare('SELECT id, name, status FROM language_proposals WHERE id = ? AND component = ?').bind(id, project.component).first<{id: number; name: string; status: string}>();
  if (!proposal) return render(tp('Not found'), `<h1>${t('Language request not found')}</h1>`, 404);
  const back = home(env, project);
  const action = String(data.action ?? '');
  if (action === 'support' || action === 'withdraw') {
    if (proposal.status !== 'open') return redirect(back);
    if (!await limit(env, 'language-support', user.id, 60, 3600)) return proposalsPage(env, user, admin, project, render, tp('Try again in a while.'));
    if (action === 'support') await env.DB.prepare('INSERT OR IGNORE INTO language_supporters (proposal_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, Date.now()).run();
    else await env.DB.prepare('DELETE FROM language_supporters WHERE proposal_id = ? AND user_id = ?').bind(id, user.id).run();
    return redirect(`${back}#language-${id}`);
  }
  if (!admin || (action !== 'add' && action !== 'decline')) return render(tp('Not allowed'), `<h1>${t('Only the Blockworked team can review language requests')}</h1>`, 403);
  const reply = String(data.reply ?? '').trim().slice(0, 500);
  if (action === 'decline') {
    await env.DB.prepare(`UPDATE language_proposals SET status = 'declined', reply = ?, decided_at = ? WHERE id = ?`).bind(reply, Date.now(), id).run();
    return redirect(`${back}?done=declined#language-${id}`);
  }
  const code = normalizeCode(String(data.code ?? ''));
  if (!CODE.test(code)) return proposalsPage(env, user, admin, project, render, tp('Use a Weblate language code such as pt_BR.'));
  try { await addLanguage(env, project.component, code); }
  catch (error) {
    if (!(error instanceof WeblateError)) throw error;
    // Already there counts as added.
    if (error.status !== 400 && error.status !== 409) return proposalsPage(env, user, admin, project, render, tp('Weblate didn’t add the language. Check WEBLATE_LANGUAGE_TOKEN, or add it in Weblate and try again.'));
  }
  await env.DB.prepare(`UPDATE language_proposals SET status = 'added', code = ?, reply = ?, decided_at = ? WHERE id = ?`).bind(code, reply, Date.now(), id).run();
  return redirect(`${back}?done=added#language-${id}`);
}

function redirect(path: string): Response { return new Response(null, {status: 303, headers: {Location: path, 'Cache-Control': 'no-store'}}); }
const BACK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;

export const PROPOSAL_CSS = `
.proposals .proposal { padding: 14px 4px; }
.proposal-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
.proposal-note { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.proposal .hint { margin: 4px 0 8px; }
.proposal button[aria-pressed="true"] { border-color: var(--accent); }
.proposal-review { margin-top: 10px; font-size: 13px; }
.proposal-review summary { cursor: pointer; width: max-content; color: var(--muted); }
.proposal-review label, .proposal-form label { display: block; margin: 10px 0 0; font-size: 13px; font-weight: 600; }
.proposal-form label { margin-bottom: 6px; }
.proposal-form .field { margin: 16px 0; }
.language-combo { position: relative; width: min(100%, 420px); }
.proposal-form .language-combo input { width: 100%; }
.language-options { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); max-height: min(340px, 50vh); overflow-y: auto; margin: 0; padding: 4px 0; list-style: none; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); box-shadow: 0 8px 24px rgb(0 0 0 / .18); }
.language-options[hidden] { display: none; }
.language-options li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0 12px; padding: 7px 12px; cursor: pointer; }
.language-options li[aria-selected="true"] { background: var(--hover); }
.language-options .language-label { overflow-wrap: anywhere; }
.language-options .language-native { display: block; color: var(--muted); font-size: 13px; }
.language-options .language-code { font: 13px/1.6 var(--mono); color: var(--muted); }
.language-options .language-note { grid-column: 1 / -1; font-size: 12px; color: var(--muted); }
.language-options .language-none { cursor: default; color: var(--muted); font-size: 13px; }
.language-picked { margin: 8px 0 0; }
.proposal-form input[type=text] { width: min(100%, 420px); font-size: 15px; padding: 9px 12px; }
.proposal-form .hint { display: block; margin-top: 6px; }
.proposal-review textarea, .proposal-form textarea { display: block; width: min(100%, 560px); padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--fg); font: inherit; resize: vertical; }
.state { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.state-open::before { background: var(--accent); }
.state-done::before, .state-translated::before { background: var(--ok); }
.state-editing::before { background: var(--warn); }
.state-off::before { background: transparent; border: 1px solid var(--muted); }
`;

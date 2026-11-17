// Languages people ask for. Anyone signed in can propose one or say they will
// help; an admin adds it to the translation projects or declines it.
import type { User } from './auth.ts';
import type { Env } from './index.ts';
import { esc } from './pages.ts';
import { t, tn, tp } from './i18n.ts';
import { limit } from './account-security.ts';
import { notify } from './notifications.ts';
import { addLanguage, components, translations, WeblateError } from './weblate.ts';
import { translationLink } from './translation-site.ts';

interface Proposal {
  id: number; code: string; name: string; note: string; status: 'open' | 'added' | 'declined'; reply: string;
  created_at: number; supporters: number; mine: number; author: string | null;
}
export type Render = (title: string, body: string, status?: number) => Response;

const CODE = /^[a-z]{2,3}(?:_[A-Z][a-z]{3})?(?:_[A-Z]{2}|_\d{3})?(?:@[a-z]{2,10})?$/;
/** pt-br, PT_BR and pt_BR all become Weblate's pt_BR. */
export function normalizeCode(code: string): string {
  const parts = code.trim().replace(/-/g, '_').split('_');
  return parts.map((p, i) => i === 0 ? p.toLowerCase() : p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()).join('_');
}

async function load(env: Env, user: User | null): Promise<Proposal[]> {
  const rows = await env.DB.prepare(`SELECT p.id, p.code, p.name, p.note, p.status, p.reply, p.created_at, u.name AS author,
      (SELECT COUNT(*) FROM language_supporters s WHERE s.proposal_id = p.id) AS supporters,
      EXISTS (SELECT 1 FROM language_supporters s WHERE s.proposal_id = p.id AND s.user_id = ?) AS mine
    FROM language_proposals p LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.status = 'open' DESC, supporters DESC, p.created_at DESC LIMIT 200`).bind(user?.id ?? '').all<Proposal>();
  return rows.results;
}

function form(env: Env, admin: boolean, p: Proposal): string {
  const action = translationLink(env, `/translate/languages/${p.id}`);
  if (p.status !== 'open') return '';
  const help = `<form method="post" action="${esc(action)}" class="inline"><input type="hidden" name="action" value="${p.mine ? 'withdraw' : 'support'}"><button type="submit"${p.mine ? ' aria-pressed="true"' : ''}>${p.mine ? t('You’ll help') : t('I’ll help translate')}</button></form>`;
  const review = admin ? `<details class="proposal-review"><summary>${t('Review')}</summary><form method="post" action="${esc(action)}">
    <label>${t('Weblate language code')}<br><input type="text" name="code" value="${esc(p.code)}" maxlength="20" required pattern="[A-Za-z_@-]{2,20}"></label>
    <label>${t('Reply to the people who asked (optional)')}<br><textarea name="reply" rows="2" maxlength="500"></textarea></label>
    <div class="translation-actions"><button class="primary" type="submit" name="action" value="add">${t('Add to every project')}</button><button type="submit" name="action" value="decline">${t('Decline')}</button></div></form></details>` : '';
  return help + review;
}

function status(p: Proposal): string {
  if (p.status === 'added') return `<span class="state state-done">${t('Added')}</span>`;
  if (p.status === 'declined') return `<span class="state state-off">${t('Not added')}</span>`;
  return `<span class="state state-open">${tn('{n} person will help', '{n} people will help', p.supporters)}</span>`;
}

export async function proposalsPage(env: Env, user: User | null, admin: boolean, render: Render, notice = ''): Promise<Response> {
  const list = await load(env, user);
  const rows = list.map(p => `<li class="proposal" id="language-${p.id}"><div class="proposal-head"><span class="translation-name" lang="${esc(p.code.replace(/_/g, '-').replace(/@.*/, ''))}">${esc(p.name)} <span class="n">${esc(p.code)}</span></span>${status(p)}</div>
    ${p.note ? `<p class="proposal-note" dir="auto">${esc(p.note)}</p>` : ''}${p.reply ? `<p class="proposal-note muted" dir="auto">${t('Reply: {text}', {text: p.reply})}</p>` : ''}
    <p class="hint">${p.author ? t('Asked by {name}', {name: p.author}) : t('Asked by a former member')}</p>${user ? form(env, admin, p) : ''}</li>`).join('');
  return render(tp('Languages'), `<p class="crumbs"><a href="${esc(translationLink(env))}">${BACK}${t('All projects')}</a></p>
    <h1>${t('Languages people asked for')}</h1>
    <p class="lede">${t('When a few people say they’ll help, the language is added to every project and you can start translating.')}</p>
    ${notice ? `<p class="translation-notice" role="status">${esc(notice)}</p>` : ''}
    <p><a class="button primary" href="${esc(translationLink(env, '/translate/languages/new'))}">${t('Propose a language')}</a></p>
    ${rows ? `<ul class="translation-list proposals">${rows}</ul>` : `<p class="empty">${t('Nobody has asked for a language yet.')}</p>`}
    ${user ? '' : `<p class="hint">${t('Sign in with your Blockworked account to propose a language or say you’ll help.')}</p>`}`);
}

export function proposalForm(env: Env, user: User | null, render: Render, error = '', draft: Record<string, unknown> = {}, statusCode = 200): Response {
  const value = (k: string) => esc(typeof draft[k] === 'string' ? draft[k] : '');
  const signin = `${new URL(env.SITE_URL).origin}/login?next=${encodeURIComponent(translationLink(env, '/translate/languages/new'))}`;
  return render(tp('Propose a language'), `<p class="crumbs"><a href="${esc(translationLink(env, '/translate/languages'))}">${BACK}${t('Languages people asked for')}</a></p>
    <h1>${t('Propose a language')}</h1>
    <p class="lede">${t('Ask for a language that isn’t open yet. It’s added once a few people say they’ll help translate it.')}</p>
    ${error ? `<p class="risky" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="${esc(translationLink(env, '/translate/languages/new'))}" class="proposal-form">
      <p><label for="language-name">${t('Language')}</label><input id="language-name" type="text" name="name" required maxlength="60" value="${value('name')}" placeholder="${esc(tp('For example, Brazilian Portuguese'))}"></p>
      <p><label for="language-code">${t('Language code, if you know it')}</label><input id="language-code" type="text" name="code" maxlength="20" value="${value('code')}" placeholder="pt_BR" autocomplete="off" spellcheck="false"><span class="hint">${t('The ISO 639 code, with a region or script after an underscore when it matters.')}</span></p>
      <p><label for="language-note">${t('Anything we should know (optional)')}</label><textarea id="language-note" name="note" rows="3" maxlength="500" dir="auto">${value('note')}</textarea></p>
      <div class="translation-actions">${user ? `<button class="primary large" type="submit">${t('Propose it')}</button>` : `<a class="button primary large" href="${esc(signin)}">${t('Sign in with Blockworked to propose')}</a>`}</div>
    </form>`, statusCode);
}

/** Every language already open in some project, by code. */
async function openLanguages(env: Env): Promise<Map<string, string>> {
  const open = new Map<string, string>();
  const results = await Promise.allSettled(components(env).map(c => translations(env, c)));
  for (const r of results) if (r.status === 'fulfilled') for (const tr of r.value) open.set(tr.language.code.toLowerCase(), tr.language.name);
  return open;
}

export async function proposeLanguage(env: Env, user: User, data: Record<string, unknown>, render: Render): Promise<Response> {
  const name = String(data.name ?? '').trim().replace(/\s+/g, ' '), note = String(data.note ?? '').trim();
  const code = normalizeCode(String(data.code ?? '') || '');
  if (!name || name.length > 60) return proposalForm(env, user, render, tp('Name the language, in up to 60 characters.'), data, 400);
  if (note.length > 500) return proposalForm(env, user, render, tp('Keep the note under 500 characters.'), data, 400);
  if (code && !CODE.test(code)) return proposalForm(env, user, render, tp('That doesn’t look like a language code. Leave it empty if you’re not sure.'), data, 400);
  const open = await openLanguages(env);
  if (code && open.has(code.toLowerCase())) return proposalForm(env, user, render, tp('{name} is already open for translation. Pick it from a project’s language list.', {name: open.get(code.toLowerCase())!}), data, 409);
  if (!await limit(env, 'language-proposal', user.id, 5, 86400)) return proposalForm(env, user, render, tp('You’ve proposed the most languages allowed in a day. Try again tomorrow.'), data, 429);
  const existing = code ? await env.DB.prepare(`SELECT id FROM language_proposals WHERE lower(code) = lower(?) AND status = 'open'`).bind(code).first<{id: number}>() : null;
  if (existing) {
    await env.DB.prepare('INSERT OR IGNORE INTO language_supporters (proposal_id, user_id, created_at) VALUES (?, ?, ?)').bind(existing.id, user.id, Date.now()).run();
    return redirect(translationLink(env, '/translate/languages') + `?done=joined#language-${existing.id}`);
  }
  const row = await env.DB.prepare(`INSERT INTO language_proposals (code, name, note, user_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .bind(code || name.toLowerCase().replace(/[^a-z]+/g, '_').slice(0, 20), name, note, user.id, Date.now()).first<{id: number}>();
  await env.DB.prepare('INSERT INTO language_supporters (proposal_id, user_id, created_at) VALUES (?, ?, ?)').bind(row!.id, user.id, Date.now()).run();
  await notify(env, {title: `Language proposed: ${name}`, text: `${user.name} asked for ${name}${code ? ` (${code})` : ''}.${note ? `\n\n${note}` : ''}`, url: new URL(translationLink(env, '/translate/languages'), env.SITE_URL).href});
  return redirect(translationLink(env, '/translate/languages') + `?done=proposed#language-${row!.id}`);
}

export async function proposalAction(env: Env, user: User, admin: boolean, id: number, data: Record<string, unknown>, render: Render): Promise<Response> {
  const proposal = await env.DB.prepare('SELECT id, name, status FROM language_proposals WHERE id = ?').bind(id).first<{id: number; name: string; status: string}>();
  if (!proposal) return render(tp('Not found'), `<h1>${t('Language request not found')}</h1>`, 404);
  const back = translationLink(env, '/translate/languages');
  const action = String(data.action ?? '');
  if (action === 'support' || action === 'withdraw') {
    if (proposal.status !== 'open') return redirect(back);
    if (!await limit(env, 'language-support', user.id, 60, 3600)) return proposalsPage(env, user, admin, render, tp('Try again in a while.'));
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
  if (!CODE.test(code)) return proposalsPage(env, user, admin, render, tp('Use a Weblate language code such as pt_BR.'));
  const failed: string[] = [];
  for (const component of components(env)) {
    try { await addLanguage(env, component, code); }
    catch (error) {
      if (!(error instanceof WeblateError)) throw error;
      // Already there counts as added.
      if (error.status !== 400 && error.status !== 409) failed.push(component);
    }
  }
  if (failed.length === components(env).length) return proposalsPage(env, user, admin, render, tp('Weblate didn’t add the language. Check WEBLATE_LANGUAGE_TOKEN, or add it in Weblate and try again.'));
  await env.DB.prepare(`UPDATE language_proposals SET status = 'added', code = ?, reply = ?, decided_at = ? WHERE id = ?`).bind(code, reply, Date.now(), id).run();
  return redirect(`${back}?done=added${failed.length ? '&missing=' + encodeURIComponent(failed.join(',')) : ''}#language-${id}`);
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

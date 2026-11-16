export const TRANSLATE_CSS = `
.translations { max-width: 860px; margin: 0 auto; }
.translation-trail { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 13px; margin-bottom: 34px; }
.translation-trail a { color: var(--muted); }
.translation-intro { margin: 0 0 32px; }
.translation-intro h1 { font-size: clamp(32px, 5vw, 48px); letter-spacing: -.025em; line-height: 1.12; }
.translation-intro > p:last-child { max-width: 54ch; font-size: 17px; }
.translation-eyebrow { color: var(--accent-light); font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin: 0 0 12px; }
.translation-project { display: flex; align-items: center; gap: 20px; padding: 26px; color: var(--fg); }
.translation-project:hover, .translation-language:hover { text-decoration: none; border-color: var(--accent); background: var(--hover); }
.translation-project h2 { margin: 0 0 8px; }
.translation-project > span:last-child { margin-left: auto; color: var(--accent-light); font-size: 24px; }
.translation-project-icon { display: grid; place-items: center; width: 52px; height: 52px; flex-shrink: 0; background: rgba(var(--accent-rgb), .12); color: var(--accent-light); border-radius: 12px; font-size: 27px; }
.translation-search { display: block; font-size: 13px; color: var(--muted); margin-bottom: 20px; }
.translation-search input { display: block; width: min(100%, 420px); margin-top: 8px; padding: 12px 14px; background: var(--bg2); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius); font: inherit; }
.translation-search input:focus-visible, .translation-target textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.translation-languages { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.translation-language { display: block; margin: 0; padding: 22px; color: var(--fg); }
.translation-language[hidden] { display: none; }
.translation-language > div:first-child { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.translation-language h2 { margin: 0; font-size: 19px; overflow-wrap: anywhere; }
.translation-language > span:last-child { display: block; margin-top: 18px; color: var(--accent-light); font-size: 13px; }
.translation-progress { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 22px 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.translation-progress progress { flex: 1; min-width: 100px; height: 5px; border: 0; border-radius: 4px; background: var(--bg3); accent-color: var(--accent); overflow: hidden; }
.translation-progress progress::-webkit-progress-bar { background: var(--bg3); }
.translation-progress progress::-webkit-progress-value { background: var(--accent); border-radius: 4px; }
.translation-progress progress::-moz-progress-bar { background: var(--accent); }
.translation-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
.translation-heading h1 { margin-bottom: 0; }
.translation-tabs { display: flex; padding: 4px; border: 1px solid var(--glass-border); background: var(--glass); border-radius: 9px; }
.translation-tabs a { padding: 7px 12px; color: var(--muted); font-size: 13px; border-radius: var(--radius); white-space: nowrap; }
.translation-tabs a[aria-current] { background: var(--bg3); color: var(--fg); }
.translation-source { padding: 24px; margin-top: 28px; }
.translation-source h2 { margin: 0 0 18px; color: var(--muted); font-size: 12px; font-weight: 600; }
.translation-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 19px; line-height: 1.6; margin: 10px 0; }
.translation-context { margin: 16px 0; color: var(--muted); font-size: 13px; }
.translation-context summary { cursor: pointer; }
.translation-context p { white-space: pre-wrap; overflow-wrap: anywhere; }
.translation-target { margin-top: 30px; }
.translation-target h2 { margin: 0 0 8px; }
.translation-target > p { font-size: 13px; margin: 0 0 18px; }
.translation-target label { display: block; margin: 18px 0 8px; font-size: 13px; font-weight: 600; }
.translation-target textarea { display: block; resize: vertical; width: 100%; min-height: 140px; padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--fg); font: inherit; font-size: 18px; line-height: 1.6; }
.translation-target textarea:disabled { opacity: .65; }
.translation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin: 24px 0; }
.translation-actions > a:last-child { margin-left: auto; }
.translation-shortcut, .translation-credit { font-size: 12px; }
.translation-notice { color: var(--ok); padding: 12px 16px; border: 1px solid currentColor; border-radius: var(--radius); font-size: 13px; }
.translation-complete { margin: 48px 0; padding: 36px; }
@media (max-width: 620px) { .translation-languages { grid-template-columns: minmax(0, 1fr); } .translation-heading { flex-direction: column; align-items: start; } .translation-shortcut { display: none; } .translation-complete { padding: 22px; } }
`;

export const TRANSLATE_JS = `
(() => {
  const search = document.getElementById('language-search');
  if (search) search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    document.querySelectorAll('[data-language]').forEach(card => {
      card.hidden = !card.dataset.language.toLocaleLowerCase().includes(query);
      if (!card.hidden) visible++;
    });
    document.getElementById('language-empty').hidden = visible > 0;
  });
  const form = document.getElementById('translation-form');
  if (!form) return;
  let dirty = form.dataset.draft === 'true';
  form.addEventListener('input', () => { dirty = true; });
  window.addEventListener('beforeunload', event => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  form.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && form.querySelector('button[type=submit]')) {
      event.preventDefault(); form.requestSubmit();
    }
  });
  form.addEventListener('submit', () => { dirty = false; });
})();
`;

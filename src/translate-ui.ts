export const TRANSLATE_CSS = `
/* Lists are rows split by hairlines, as a pack's block list is; no card grid. */
.translation-list { list-style: none; padding: 0; margin: 20px 0; border-top: 1px solid var(--glass-border); }
.translation-list li { border-bottom: 1px solid var(--glass-border); }
.translation-list li[hidden] { display: none; }
.translation-list a { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 16px; padding: 14px 4px; color: var(--fg); transition: background 120ms var(--ease); }
.translation-list a:hover { background: var(--hover); text-decoration: none; }
.translation-name { font-weight: 700; font-size: 16px; }
.translation-list .n { font-size: 13px; margin-left: 4px; }
.languages a { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: center; }
.languages .translation-progress { margin: 0; }
.translation-search { max-width: 420px; margin: 20px 0 0; }
.translation-progress { display: grid; grid-template-columns: minmax(60px, 1fr) auto; align-items: center; gap: 12px; margin: 10px 0 0; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.translation-progress span { min-width: 17ch; text-align: right; white-space: nowrap; }
.translation-progress progress { width: 100%; height: 4px; border: 0; border-radius: 2px; background: var(--bg3); accent-color: var(--accent); overflow: hidden; }
.translation-progress progress::-webkit-progress-bar { background: var(--bg3); }
.translation-progress progress::-webkit-progress-value { background: var(--accent); }
.translation-progress progress::-moz-progress-bar { background: var(--accent); }
.translation-progress { max-width: 560px; }
.languages .translation-progress { max-width: none; }
.translation-actions > a:not(.button) { font-size: 13px; }
/* Underlined like a pack page's tabs. */
.translation-tabs { display: flex; gap: 2px; margin: 20px 0 16px; border-bottom: 1px solid var(--glass-border); }
.translation-tabs a { padding: 6px 10px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--muted); font-size: 13px; font-weight: 600; white-space: nowrap; }
.translation-tabs a:hover { color: var(--fg); text-decoration: none; }
.translation-tabs a[aria-current] { color: var(--fg); border-bottom-color: var(--accent); }
.translation-source { margin-top: 0; }
.translation-source .muted { font-size: 13px; margin: 10px 0 0; }
.translation-source h2 { margin: 0 0 6px; color: var(--muted); font-size: 13px; font-weight: 600; }
.translation-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 17px; line-height: 1.55; margin: 4px 0; }
.translation-context { margin: 12px 0; color: var(--muted); font-size: 13px; }
.translation-context summary { cursor: pointer; width: max-content; }
.translation-context p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
.translation-target { margin-top: 24px; }
.translation-target h2 { margin: 0 0 4px; font-size: 17px; }
.translation-target > p { font-size: 13px; margin: 0 0 12px; }
.translation-target label { display: block; margin: 14px 0 6px; font-size: 13px; font-weight: 600; }
.translation-target textarea { display: block; resize: vertical; width: 100%; min-height: 96px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--fg); font: inherit; font-size: 17px; line-height: 1.55; }
.translation-target textarea:disabled { opacity: .65; }
.translation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 20px 0; }
.translation-skip { margin-left: auto; font-size: 13px; color: var(--muted); }
.translation-skip:hover { color: var(--fg); }
.translation-shortcut, .translation-credit { font-size: 13px; }
.translation-shortcut kbd { font: inherit; font-weight: 600; color: var(--fg); }
.translation-notice { color: var(--ok); font-size: 13px; font-weight: 600; margin: 0 0 12px; }
@media (max-width: 620px) { .languages a { grid-template-columns: minmax(0, 1fr); gap: 6px; } .translation-shortcut { display: none; } }
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
  if (/Mac|iPhone|iPad/.test(navigator.platform)) form.querySelectorAll('.translation-shortcut kbd:first-child').forEach(k => { k.textContent = '⌘'; });
})();
`;

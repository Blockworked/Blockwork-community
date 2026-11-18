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
.translation-meta-line { width: 100%; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.translation-tabs-end { margin-left: auto; }
/* Search under the tabs: one row, wraps on phones. */
.translation-find { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.translation-find .search { flex: 1 1 260px; }
.translation-find .search input { font-size: 13px; padding: 7px 10px 7px 34px; }
.translation-find select, .translation-actions select { font: inherit; font-size: 13px; padding: 0 8px; min-height: 32px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg2); color: var(--fg); }
/* The string list: English and the translation side by side, split by hairlines. */
.strings a { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 15rem; align-items: baseline; gap: 4px 20px; }
.string-source, .string-target { overflow-wrap: anywhere; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.string-state { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 10px; }
.string-flag { font-size: 12px; color: var(--muted); }
.translation-pages { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; font-size: 13px; }
.translation-step { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 0 0 10px; font-size: 13px; }
.translation-position { margin: 0; }
.translation-step-links { display: flex; gap: 16px; margin-left: auto; }
.translation-step-links a { color: var(--muted); }
.translation-step-links a:hover { color: var(--fg); }
.translation-source-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.translation-source-head button { min-height: 26px; font-size: 12px; }
/* Placeholders are buttons: click one to put it at the cursor. */
.ph { display: inline; min-height: 0; padding: 0 4px; margin: 0 1px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg3); color: var(--fg); font: 0.88em/1.4 var(--mono); vertical-align: 1px; white-space: pre; }
.ph:disabled { cursor: default; }
.translation-changed { font-size: 13px; color: var(--muted); border-top: 1px solid var(--glass-border); padding-top: 10px; margin: 12px 0 0; white-space: pre-wrap; }
.translation-meta, .translation-glossary dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 12px 0; font-size: 13px; }
.translation-meta dt, .translation-glossary dt { color: var(--muted); }
.translation-glossary dt { color: var(--fg); font-weight: 600; }
.translation-meta dd, .translation-glossary dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.translation-glossary { margin: 16px 0; }
.translation-glossary h2, .translation-panel h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.translation-panel h2 .n, .translation-panel summary .n { font-weight: 400; }
.translation-warning { color: var(--warn); font-size: 13px; margin: 8px 0 0; }
:root[data-theme="light"] .translation-warning { color: #8a6a00; }
.translation-check { display: flex !important; align-items: center; gap: 8px; font-weight: 400 !important; color: var(--muted); }
.translation-check input { margin: 0; }
.translation-panel { margin: 28px 0 0; padding-top: 16px; border-top: 1px solid var(--glass-border); }
.translation-panel summary { cursor: pointer; list-style: none; }
.translation-panel summary::-webkit-details-marker { display: none; }
.translation-panel summary h2 { display: inline; }
.translation-panel summary h2::after { content: " +"; }
.translation-panel details[open] summary h2::after { content: " −"; }
.translation-rows { list-style: none; padding: 0; margin: 8px 0 0; }
.translation-rows li { padding: 8px 0; border-bottom: 1px solid var(--glass-border); }
.translation-rows li:last-child { border-bottom: 0; }
.translation-rows .translation-text { font-size: 15px; margin: 0; }
.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 6px; font-size: 13px; }
.row-actions button { min-height: 26px; font-size: 12px; }
.other-languages li { display: grid; grid-template-columns: minmax(110px, 0.35fr) minmax(0, 1fr); gap: 4px 16px; font-size: 13px; }
.comment-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.translation-rows time { font-size: 12px; }
.comment-form label { display: block; margin: 12px 0 6px; font-size: 13px; font-weight: 600; }
.comment-form textarea { display: block; width: 100%; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--fg); font: inherit; resize: vertical; }
.comment-form .translation-actions { margin: 10px 0 0; }
.translation-shots { display: flex; flex-wrap: wrap; gap: 10px; }
.translation-shots img { display: block; max-width: min(100%, 280px); max-height: 180px; border-radius: var(--radius); border: 1px solid var(--glass-border); }
@media (max-width: 620px) { .strings a { grid-template-columns: minmax(0, 1fr); gap: 4px; } .string-state { justify-content: flex-start; } .other-languages li { grid-template-columns: minmax(0, 1fr); gap: 0; } .translation-tabs { overflow-x: auto; } }
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
  // The language picker: search Weblate's languages by any of their names or code.
  const catalog = document.getElementById('language-catalog'), nameInput = document.getElementById('language-name');
  if (catalog && nameInput) {
    const data = JSON.parse(catalog.textContent), list = document.getElementById('language-options');
    const codeInput = document.getElementById('language-code'), picked = document.getElementById('language-picked');
    const fold = s => s.normalize('NFD').replace(/\\p{M}/gu, '').toLocaleLowerCase();
    const ui = document.documentElement.lang || 'en';
    let local = null;
    try { if (!/^en\\b/.test(ui)) local = new Intl.DisplayNames([ui], {type: 'language', fallback: 'none'}); } catch {}
    const open = new Map(Object.entries(data.open)), asked = new Set(data.asked);
    const entries = data.languages.map(([code, english, native, aliases]) => {
      const tag = code.replace(/@.*/, '').replace(/_/g, '-');
      let mine = '';
      try { mine = local ? local.of(tag) || '' : ''; } catch {}
      if (mine === english || mine === native) mine = '';
      const names = [english, native, mine, aliases].filter(Boolean).map(fold);
      return {code, english, native, mine, names, codes: [code.toLowerCase(), tag.toLowerCase()], base: !/[_@]/.test(code)};
    });
    const words = n => n.split(/[^\\p{L}\\p{N}]+/u).filter(Boolean);
    entries.forEach(e => { e.words = e.names.flatMap(words); });
    // Lower is better: a code, a whole name, a name's start, every word's start, then anywhere.
    const rank = (e, q, parts) => {
      if (e.codes.includes(q.replace(/\\s+/g, ''))) return 0;
      if (e.names.includes(q)) return 1;
      if (e.names.some(n => n.startsWith(q))) return 2;
      if (parts.length && parts.every(w => e.words.some(x => x.startsWith(w)))) return 3;
      if (e.codes.some(c => c.startsWith(q))) return 4;
      if (q.length > 2 && e.names.some(n => n.includes(q))) return 5;
      return 9;
    };
    let shown = [], active = -1, chosen = null;
    const close = () => { list.hidden = true; nameInput.setAttribute('aria-expanded', 'false'); nameInput.removeAttribute('aria-activedescendant'); active = -1; };
    const mark = i => {
      active = i;
      list.querySelectorAll('[role=option]').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
      const li = list.querySelector('#language-option-' + i);
      if (li) { nameInput.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({block: 'nearest'}); } else nameInput.removeAttribute('aria-activedescendant');
    };
    const status = code => open.has(code.toLowerCase()) ? 'open' : asked.has(code.toLowerCase()) ? 'asked' : '';
    const show = () => {
      const q = fold(nameInput.value.trim());
      if (!q) { close(); return; }
      const parts = words(q);
      shown = entries.map(e => [rank(e, q, parts), e]).filter(([r]) => r < 9)
        // Widely used languages have names of their own in the browser's data; they come first.
        .sort((a, b) => a[0] - b[0] || !!b[1].native - !!a[1].native || b[1].base - a[1].base || a[1].english.length - b[1].english.length || a[1].english.localeCompare(b[1].english))
        .slice(0, 30).map(([, e]) => e);
      list.replaceChildren(...(shown.length ? shown.map((e, i) => {
        const li = document.createElement('li'), label = document.createElement('span'), code = document.createElement('span');
        li.id = 'language-option-' + i; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
        label.className = 'language-label'; label.textContent = e.mine || e.english;
        const other = [e.mine ? e.english : '', e.native].filter(Boolean).join(' · ');
        if (other) { const n = document.createElement('span'); n.className = 'language-native'; n.textContent = other; if (e.native) n.lang = e.code.replace(/@.*/, '').replace(/_/g, '-'); label.append(n); }
        code.className = 'language-code'; code.textContent = e.code;
        li.append(label, code);
        const s = status(e.code);
        if (s) { const n = document.createElement('span'); n.className = 'language-note'; n.textContent = list.dataset[s]; li.append(n); }
        li.addEventListener('mousedown', event => { event.preventDefault(); pick(e); });
        return li;
      }) : [Object.assign(document.createElement('li'), {className: 'language-none', textContent: list.dataset.none})]));
      list.hidden = false; nameInput.setAttribute('aria-expanded', 'true');
      mark(shown.length ? 0 : -1);
    };
    const explain = e => {
      const s = e ? status(e.code) : '';
      picked.hidden = !s; picked.replaceChildren();
      if (!s) return;
      picked.append(picked.dataset[s].replace('{name}', e.english));
      if (s === 'open') { const a = document.createElement('a'); a.href = open.get(e.code.toLowerCase()); a.textContent = picked.dataset.translate; picked.append(' ', a); }
    };
    const pick = e => {
      chosen = e; nameInput.value = e.english; codeInput.value = e.code;
      close(); explain(e);
    };
    nameInput.addEventListener('input', () => {
      // Typing over a picked language forgets its code.
      if (chosen && codeInput.value === chosen.code) codeInput.value = '';
      chosen = null; explain(null); show();
    });
    nameInput.addEventListener('focus', () => { if (!chosen && nameInput.value.trim()) show(); });
    nameInput.addEventListener('blur', close);
    nameInput.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) { show(); return; }
        if (shown.length) mark((active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) { event.preventDefault(); pick(shown[active]); }
      else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); close(); }
    });
    // A code typed by hand picks its language too.
    codeInput.addEventListener('change', () => {
      const q = codeInput.value.trim().toLowerCase().replace(/-/g, '_'), e = entries.find(x => x.code.toLowerCase() === q);
      if (e) { codeInput.value = e.code; if (!nameInput.value.trim()) nameInput.value = e.english; chosen = e; }
      explain(e);
    });
    if (codeInput.value) codeInput.dispatchEvent(new Event('change'));
  }
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
  const areas = [...form.querySelectorAll('textarea')];
  let last = areas[0];
  areas.forEach(a => a.addEventListener('focus', () => { last = a; }));
  const put = (area, text) => {
    if (!area || area.disabled) return;
    const start = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? start;
    area.setRangeText(text, start, end, 'end'); area.focus(); area.dispatchEvent(new Event('input', {bubbles: true}));
  };
  // Placeholders in the English text insert themselves; copy and suggestions fill every form.
  document.addEventListener('click', event => {
    const ph = event.target.closest && event.target.closest('[data-insert]');
    if (ph) { event.preventDefault(); put(last, ph.dataset.insert); return; }
    const fill = event.target.closest && event.target.closest('[data-copy-source], [data-fill]');
    if (!fill) return;
    const values = JSON.parse(fill.dataset.copySource || fill.dataset.fill);
    areas.forEach((a, i) => { if (!a.disabled) a.value = values[Math.min(i, values.length - 1)] ?? ''; });
    if (areas[0]) { areas[0].focus(); areas[0].dispatchEvent(new Event('input', {bubbles: true})); }
  });
  if (areas.every(a => a.disabled)) document.querySelectorAll('.ph').forEach(b => { b.disabled = true; });
  // Say which placeholders a translation leaves out, as you type.
  const wanted = JSON.parse(form.dataset.placeholders || '[]'), warning = document.getElementById('placeholder-warning');
  const check = () => {
    if (!warning || !wanted.length) return;
    const missing = wanted.filter(p => areas.some(a => a.value.trim() && !a.value.includes(p)));
    warning.hidden = !missing.length;
    warning.textContent = missing.length ? (warning.dataset.label || 'Missing from your translation:') + ' ' + missing.join('  ') : '';
  };
  form.addEventListener('input', check); check();
  form.addEventListener('keydown', event => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const link = document.querySelector(event.key === 'ArrowRight' ? 'a[rel=next]' : 'a[rel=prev]');
      if (link) { event.preventDefault(); location.href = link.href; }
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) form.querySelectorAll('.translation-shortcut kbd:first-child').forEach(k => { k.textContent = '⌘'; });
})();
`;

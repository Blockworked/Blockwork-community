// Server-rendered HTML. Every value goes through esc().

import type { User } from "./auth.ts";
import { PROVIDERS } from "./auth.ts";
import { CAPABILITIES } from "./packs.ts";
import { SITE_NAV_CSS, siteFooter, siteHeader, type NavPlace } from "./site-nav.ts";
import { BROWSE_CSS } from "./browse-css.ts";
import { SUPPORT_CSS } from "./support-css.ts";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Blockwork's look: the color, radius and control tokens of the app's Qt theme
// (blockstitch qml/Blockstitch/Theme.qml) as blockworked.com uses them
// (src/styles/theme.css and global.css there), dark first with the same light
// variant. /site.js sets data-theme from the theme cookie the two sites share
// (or the OS); without it, the light one follows the OS.
const LIGHT = `
    color-scheme: light;
    --bg: #f2f2f5; --bg2: #ffffff; --bg3: #e7e7ec; --border: #d4d4da;
    --fg: #1c1c1e; --muted: #6e6e73;
    --warn: #6b5300; --warn-bg: #fff6d8; --warn-border: #e6c200; --ok: #18743b;
    --block: #e7e7ec; --block-top: #f4f4f7;
    --glass: rgba(255, 255, 255, 0.6); --glass-strong: rgba(230, 230, 236, 0.75); --glass-border: rgba(0, 0, 0, 0.12);
    --hover: rgba(0, 0, 0, 0.04);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.08); --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.1);`;

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #1c1c1e; --bg2: #2c2c2e; --bg3: #3a3a3c; --border: #48484a;
  --fg: #e0e0e0; --muted: #8e8e93;
  --accent: #0a84ff; --accent-light: #3aa0ff; --accent-rgb: 10, 132, 255;
  --warn: #ffd60a; --warn-bg: #2d2200; --warn-border: #7d6200; --ok: #3ccf6e;
  --block: #3b3c40; --block-top: #44454a;
  --glass: rgba(44, 44, 46, 0.55); --glass-strong: rgba(58, 58, 60, 0.6); --glass-border: rgba(255, 255, 255, 0.08);
  --hover: rgba(255, 255, 255, 0.05);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.25); --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.35);
  --radius: 6px; --radius-lg: 14px;
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --font: "Atkinson Hyperlegible Next", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, monospace;
}
:root[data-theme="light"] {${LIGHT}
}
@media (prefers-color-scheme: light) { :root:not([data-theme]) {${LIGHT}
} }
@font-face { font-family: "Atkinson Hyperlegible Next"; font-style: normal; font-weight: 200 800; font-display: swap; src: url(/fonts/atkinson-hyperlegible-next-normal-latin.woff2) format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Atkinson Hyperlegible Next"; font-style: normal; font-weight: 200 800; font-display: swap; src: url(/fonts/atkinson-hyperlegible-next-normal-latin-ext.woff2) format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Atkinson Hyperlegible Next"; font-style: italic; font-weight: 200 800; font-display: swap; src: url(/fonts/atkinson-hyperlegible-next-italic-latin.woff2) format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Atkinson Hyperlegible Next"; font-style: italic; font-weight: 200 800; font-display: swap; src: url(/fonts/atkinson-hyperlegible-next-italic-latin-ext.woff2) format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF; }
* { box-sizing: border-box; }
html { scrollbar-width: thin; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
::selection { background: rgba(var(--accent-rgb), 0.35); }
.container { width: 100%; max-width: 920px; margin: 0 auto; padding: 0 24px; }
main { flex: 1; padding: 40px 0 72px; }
h1, h2, h3 { line-height: 1.2; text-wrap: balance; }
h1 { font-size: clamp(28px, 4vw, 36px); font-weight: 700; margin: 0 0 12px; }
h2 { font-size: 20px; font-weight: 700; margin: 36px 0 12px; }
h3 { font-size: 17px; font-weight: 700; margin: 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: var(--mono); }
.muted { color: var(--muted); }
.risky { color: var(--warn); font-weight: 600; }

/* The library's own bar under the shared header (site-nav.ts): its name and
   the account links. */
.subbar { border-bottom: 1px solid var(--glass-border); }
.subbar .container { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; min-height: 48px; padding-top: 6px; padding-bottom: 6px; }
.subbar-title { margin-right: auto; color: var(--fg); font-weight: 700; font-size: 15px; }
.subbar-title:hover { text-decoration: none; }
.subbar nav { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.subbar nav a { padding: 6px 10px; border-radius: var(--radius); font-size: 13px; color: var(--muted); transition: background 120ms var(--ease), color 120ms var(--ease); }
.subbar nav a:hover { background: var(--hover); color: var(--fg); text-decoration: none; }
.who { display: inline-flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; font-size: 13px; font-weight: 600; }
${SITE_NAV_CSS}
.settings-layout { display: grid; grid-template-columns: 150px minmax(0,1fr); gap: 24px; margin-top: 24px; }
.settings-nav { display: flex; flex-direction: column; gap: 6px; align-self: start; position: sticky; top: 16px; }
.settings-nav a { padding: 10px 14px; border-radius: var(--radius); color: var(--muted); }
.settings-nav a[aria-current=page] { background: var(--hover); color: var(--fg); font-weight: 700; }
.settings-content { min-width: 0; }
.settings-content > h2 { margin-top: 0; }
.settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.settings-actions form { margin: 0; }
.settings-content .card > form + h3 { margin-top: 24px; }
.connection-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.connection-row p { margin: 0; }
.settings-content .card > form + form { margin-top: 12px; }
.settings-content button { white-space: normal; line-height: 1.3; padding-top: 7px; padding-bottom: 7px; }
.profile-picture { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; }
@media (max-width: 640px) { .settings-layout { grid-template-columns: minmax(0,1fr); gap: 16px; } .settings-nav { position: static; flex-direction: row; } }
/* Home page intro. */
.hero { margin: -40px 0 28px; padding: 56px 0 40px; border-bottom: 1px solid var(--glass-border); }
.hero h1 { font-size: clamp(32px, 5vw, 44px); margin-bottom: 8px; }
.hero p { max-width: 60ch; font-size: 17px; line-height: 1.65; color: color-mix(in srgb, var(--fg) 78%, var(--muted)); }
.hero .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-top: 24px; font-size: 14px; color: var(--muted); }
.hero kbd { font: inherit; font-weight: 600; color: var(--fg); }

/* Panels: the app's settings sections, as blockworked.com draws them. */
.card { background: var(--glass); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 18px 20px; margin: 14px 0; }
.card > :first-child { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
.card p { margin: 8px 0; }
.card .by { margin-top: 2px; font-size: 13px; }
/* A version sits in the same box a block's value does in the editor. */
.version { display: inline-block; vertical-align: 2px; margin-left: 6px; padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 12px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
h1 .version { font-size: 15px; vertical-align: 6px; }
ul.caps { margin: 10px 0 0; padding: 0; list-style: none; font-size: 13px; }
ul.caps li { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
ul.caps li::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
li.risky::before { background: var(--warn); }
.card .status { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--glass-border); font-size: 13px; }
ol { padding-left: 22px; }
ol li { margin: 4px 0; }

/* Controls: blockworked.com's .btn and .btn-primary. */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg3); color: var(--fg); font: inherit; font-size: 13px; line-height: 1; white-space: nowrap; cursor: pointer; text-decoration: none; transition: background 120ms var(--ease), border-color 120ms var(--ease); }
button:hover, .button:hover { background: var(--hover); text-decoration: none; }
button:active, .button:active { opacity: 0.85; }
button:focus-visible, .button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
button.primary:hover, .button.primary:hover { background: var(--accent-light); }
button.ghost { background: transparent; border-color: transparent; color: var(--muted); }
button.ghost:hover { background: var(--hover); color: var(--fg); }
button.large, .button.large { min-height: 44px; padding: 0 20px; font-size: 15px; border-radius: 8px; }
.signin { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 20px; }
.signin .button { min-width: 240px; }
form.inline { display: inline; }
input[type=text], input[type=email], input[type=password], input[type=file] { font: inherit; font-size: 13px; padding: 7px 10px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg2); color: var(--fg); width: min(100%, 420px); transition: box-shadow 120ms var(--ease), border-color 120ms var(--ease); }
input[type=text]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.28); }
input[type=file]::file-selector-button { font: inherit; margin-right: 10px; padding: 5px 10px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg3); color: var(--fg); cursor: pointer; }

/* blockworked.com's warning banner, for form errors. */
p.risky { padding: 10px 12px; border-radius: var(--radius-lg); border: 1px solid var(--warn-border); background: var(--warn-bg); font-size: 13px; box-shadow: var(--shadow-sm); }
pre { overflow: auto; max-height: 480px; background: var(--bg2); border: 1px solid var(--glass-border); border-radius: var(--radius-lg); padding: 14px 16px; font-size: 12px; line-height: 1.5; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
img.avatar { width: 22px; height: 22px; border-radius: 50%; }
.verified { display: inline-flex; vertical-align: -2px; margin-left: 4px; color: var(--accent); }

@media (max-width: 560px) {
  .container { padding: 0 16px; }
  .site-header .container, .site-footer .container { padding: 0 16px; }
  .who { display: none; }
  .subbar nav a { padding: 6px 8px; }
  .site-footer .copyright { margin-left: 0; }
}
${BROWSE_CSS}
${SUPPORT_CSS}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** The bar under the shared header: whose section of the site this is, and its links. */
export interface Shell {
  name: string;
  href: string;
  nav: string;
  /** Where the browser title says the page is. */
  site: string;
  place?: NavPlace;
}

export function libraryShell(user: User | null, admin: boolean): Shell {
  const nav = user
    ? `<a href="/submit">Submit a pack</a><a href="/me">My packs</a><a href="/account">Account settings</a>${admin ? `<a href="/admin">Review</a>` : ""}
       <span class="who">${user.avatar ? `<img class="avatar" src="${esc(user.avatar)}" alt="">` : ""}${esc(user.name)}</span>
       <form class="inline" method="post" action="/auth/logout"><button class="ghost">Sign out</button></form>`
    : `<a href="/login">Sign in</a>`;
  return { name: "Community blocks", href: "/", nav, site: "Blockwork community blocks" };
}

export function page(title: string, user: User | null, admin: boolean, body: string, status = 200, shell = libraryShell(user, admin)): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(shell.site)}</title><link rel="icon" type="image/png" href="/favicon.png">
<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f2f2f5" media="(prefers-color-scheme: light)">
<script src="/site.js"></script><style>${STYLE}</style></head>
<body>${siteHeader(shell.place)}
<div class="subbar"><div class="container"><a class="subbar-title" href="${esc(shell.href)}">${esc(shell.name)}</a><nav aria-label="${esc(shell.name)}">${shell.nav}</nav></div></div>
<main><div class="container">${body}</div></main>
${siteFooter(shell.place)}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function capabilityList(kinds: string[]): string {
  if (!kinds.length) return `<p class="muted">Doesn't use any blocks that need permission.</p>`;
  const items = CAPABILITIES.filter(([k]) => kinds.includes(k)).map(
    ([, label, risky]) => `<li${risky ? ` class="risky"` : ""}>${esc(label)}</li>`,
  );
  return `<ul class="caps">${items.join("")}</ul>`;
}

/** The checkmark next to the author of a pack published by the Blockworked team. */
export function verifiedBadge(): string {
  return `<span class="verified" title="Verified official pack" role="img" aria-label="Verified official pack"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function input(name: string, label: string, type = 'text', autocomplete = name): string {
  return `<p><label>${esc(label)}<br><input name="${esc(name)}" type="${type}" autocomplete="${autocomplete}" required ${type === 'password' ? 'minlength="15" maxlength="128"' : 'maxlength="254"'}></label></p>`;
}
export function emailLogin(next: string): string {
  return `<div class="card"><h2>Sign in with email</h2><form method="post" action="/auth/email/login">
    <input type="hidden" name="next" value="${esc(next)}">${input('email', 'Email', 'email', 'username')}${input('password', 'Password', 'password', 'current-password')}
    <button class="primary">Sign in</button></form><p><a href="/auth/email/signup">Create an account</a> · <a href="/auth/email/forgot">Forgot password?</a></p></div>
    <button type="button" data-passkey="login" data-next="${esc(next || '/account/security')}">Sign in with a passkey</button><p id="auth-status" role="status"></p><script src="/account.js" defer></script>`;
}

export function loginPage(user: User | null, next: string, local = false): Response {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  const buttons = Object.entries(PROVIDERS)
    .map(([id, name]) => `<a class="button large" href="/auth/${id}/login${q}">Sign in with ${esc(name)}</a>`)
    .join("");
  return page(
    "Sign in",
    user,
    false,
    `<h1>Sign in</h1><p class="muted">An account is needed to submit packs. Browsing doesn't need one.</p><div class="signin">${buttons}</div>${local ? emailLogin(next) : ""}`,
  );
}

export function message(user: User | null, admin: boolean, title: string, text: string, status = 200): Response {
  return page(title, user, admin, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, status);
}

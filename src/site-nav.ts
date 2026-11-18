// The top nav, footer and page-to-page fade shared with blockworked.com, so
// the two sites read as one. This is a copy: blockworked.com
// (Blockworked/blockworked.com) keeps the originals in src/lib/site.ts (the
// link list), src/components/SiteHeader.astro and SiteFooter.astro (markup
// and styles) and src/layouts/Base.astro (the theme and fade scripts). Change
// both together.

import { language, languages, raw, t, tn, tp } from './i18n.ts';
import { esc } from "./pages.ts";

let mainUrl = "https://blockworked.com";
let supportUrl = "https://support.blockworked.com";
let translateUrl = "https://translate.blockworked.com";

/** Points the shared links at a different main site, like a local
 *  `pnpm dev` (MAIN_SITE_URL in wrangler.toml), the helpdesk and the
 *  translation site. */
export function setMainSite(url: string | undefined, support?: string, translate?: string): void {
  if (url) mainUrl = url.replace(/\/$/, "");
  if (support) supportUrl = support.replace(/\/$/, "");
  if (translate) translateUrl = translate.replace(/\/$/, "");
}

/** A menu of the languages the site is translated into; hidden until there is a choice. */
function languagePicker(): string {
  const list = languages();
  if (list.length < 2) return "";
  const current = language().code;
  return `<label class="language-picker"><span class="sr">${t("Language")}</span><select data-language-picker aria-label="${t("Language")}">${list
    .map((l) => `<option value="${esc(l.code)}" lang="${esc(l.tag)}"${l.code === current ? " selected" : ""}>${esc(l.name)}</option>`)
    .join("")}</select></label>`;
}

/** Where the community library's links point from the page being drawn:
 *  "/" on the library itself, its full address from the helpdesk. */
export interface NavPlace {
  community: string;
  section: "community" | "support" | "translations";
}

const LIBRARY: NavPlace = { community: "/", section: "community" };

const REPO_URL = "https://github.com/Blockworked/Blockwork";

function navLinks(place: NavPlace): { href: string; label: string; current?: boolean }[] {
  return [
    { href: `${mainUrl}/#features`, label: tp("Features") },
    { href: `${mainUrl}/#screenshots`, label: tp("Screenshots") },
    { href: `${mainUrl}/download`, label: tp("Download") },
    { href: `${mainUrl}/changelog`, label: tp("Changelog") },
    { href: place.community, label: tp("Community"), current: place.section === "community" },
    { href: `${supportUrl}/`, label: tp("Support"), current: place.section === "support" },
    { href: `${translateUrl}/`, label: tp("Translate"), current: place.section === "translations" },
  ];
}

// Lucide's sun, moon and download icons and the GitHub mark, as the main
// site renders them.
const ICON = `xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const SUN = `<svg ${ICON} class="icon-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON = `<svg ${ICON} class="icon-moon"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`;
const DOWNLOAD = `<svg ${ICON}><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;
const GITHUB = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" width="16" height="16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

export function siteHeader(place = LIBRARY): string {
  const links = navLinks(place)
    .map((l) => `<a href="${esc(l.href)}"${l.current ? ` aria-current="page"` : ""}>${l.label}</a>`)
    .join("");
  return `<header class="site-header"><div class="container site-header-inner">
<a class="brand" href="${esc(mainUrl)}/"><img src="/logo.png" alt="" width="28" height="28"><span>Blockwork</span></a>
<nav class="site-nav" aria-label="${t('Main')}">${links}</nav>
<div class="site-header-actions">
<a class="btn btn-icon btn-ghost" href="${REPO_URL}" title="${t('Blockwork on GitHub')}" aria-label="${t('Blockwork on GitHub')}">${GITHUB}</a>
<button class="btn btn-icon btn-ghost theme-toggle" type="button" title="${t('Toggle light/dark theme')}" aria-label="${t('Toggle light/dark theme')}">${SUN}${MOON}</button>
<a class="btn btn-primary header-cta" href="${esc(mainUrl)}/download">${DOWNLOAD}Download</a>
</div></div></header>`;
}

/** The line under sign-in and sign-up forms pointing at the terms and privacy policy on blockworked.com. */
export function agreement(): string {
  return `<p class="muted agreement">${t('By signing in or creating an account, you agree to the {terms} and the {privacy}.', {
    terms: raw(`<a href="${esc(mainUrl)}/terms">${t('Terms of Service')}</a>`),
    privacy: raw(`<a href="${esc(mainUrl)}/privacy">${t('Privacy Policy')}</a>`),
  })}</p>`;
}

export function siteFooter(place = LIBRARY): string {
  const year = new Date().getFullYear();
  const links = navLinks(place)
    .map((link) => `<a href="${esc(link.href)}">${link.label}</a>`)
    .join("");
  return `<footer class="site-footer"><div class="container site-footer-inner">
<div class="footer-primary">
<a class="footer-brand" href="${esc(mainUrl)}/"><img src="/logo.png" alt="" width="22" height="22"><span>Blockwork</span></a>
<nav class="footer-links" aria-label="${t('Footer')}">${links}</nav>
</div><div class="footer-meta">
<a href="${REPO_URL}">${t('Blockwork on GitHub')}</a><a href="${REPO_URL}/issues">${t('Report an issue')}</a><a href="${REPO_URL}/releases">${t('All releases')}</a>
<a href="https://github.com/Blockworked/Blockwork-community">${t('Library source')}</a>
<a href="${esc(mainUrl)}/privacy">${t('Privacy')}</a><a href="${esc(mainUrl)}/terms">${t('Terms')}</a>
${languagePicker()}<p class="copyright">© ${year} Blockworked</p></div></div></footer>`;
}

/** Header and footer styles, matching blockworked.com's SiteHeader and
 *  SiteFooter. Uses the page's color tokens from pages.ts. */
export const SITE_NAV_CSS = `
.site-header { position: sticky; top: 0; z-index: 50; background: var(--glass); view-transition-name: site-header;
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); border-bottom: 1px solid var(--glass-border); box-shadow: var(--shadow-sm); }
.site-header .container, .site-footer .container { max-width: 1120px; padding: 0 24px; }
.site-header-inner { display: flex; align-items: center; gap: 12px; height: 56px; }
.brand { display: flex; align-items: center; gap: 8px; color: var(--fg); font-weight: 700; font-size: 17px; line-height: 1; }
.brand:hover { text-decoration: none; }
.brand img { width: 28px; height: 28px; }
.site-nav { display: flex; gap: 2px; margin-left: 16px; }
.site-nav a { padding: 6px 10px; border-radius: var(--radius); font-size: 13px; color: var(--muted); text-decoration: none; transition: background 120ms var(--ease), color 120ms var(--ease); }
.site-nav a:hover { background: var(--hover); color: var(--fg); text-decoration: none; }
.site-nav a[aria-current="page"] { color: var(--fg); }
.site-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg3); color: var(--fg); cursor: pointer; font: inherit; font-size: 13px; line-height: 1;
  text-decoration: none; white-space: nowrap; transition: background 120ms var(--ease), border-color 120ms var(--ease), color 120ms var(--ease); }
.btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.btn:hover { background: var(--hover); text-decoration: none; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.btn-primary:hover { background: var(--accent-light); }
.btn-icon { min-width: 32px; padding: 0; }
.btn-ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn-ghost:hover { background: var(--hover); color: var(--fg); }
.theme-toggle .icon-moon { display: none; }
:root[data-theme="light"] .theme-toggle .icon-sun { display: none; }
:root[data-theme="light"] .theme-toggle .icon-moon { display: block; }
@media (max-width: 920px) { .site-nav { display: none; } }
@media (max-width: 400px) { .header-cta { display: none; } }

.site-footer { border-top: 1px solid var(--glass-border); background: var(--glass); padding: 20px 0; font-size: 13px; color: var(--muted); }
.footer-primary, .footer-links, .footer-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }
.footer-brand { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--fg); }
.footer-brand img { width: 22px; height: 22px; }
.footer-links a, .footer-meta a { color: inherit; }
.site-footer a:hover { color: var(--fg); text-decoration: none; }
.footer-meta { border-top: 1px solid var(--glass-border); margin-top: 12px; padding-top: 12px; }
.site-footer .copyright { margin: 0 0 0 auto; }
@media (max-width: 560px) {
  .footer-brand, .site-footer .copyright { flex-basis: 100%; }
  .site-footer .copyright { margin-left: 0; }
}
.language-picker select { font: inherit; font-size: 13px; min-height: 28px; padding: 0 6px; border-radius: var(--radius); border: 1px solid var(--glass-border); background: transparent; color: var(--muted); }
.language-picker select:hover { color: var(--fg); }
.site-footer .sr, .language-picker .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Moving between pages: a cross-fade within the site (the header keeps its
   place), and a fade of everything under the header when crossing to or from
   blockworked.com (see SITE_JS). */
@view-transition { navigation: auto; }
main, .site-footer { transition: opacity 180ms var(--ease); }
.xsite-in main, .xsite-in .site-footer, .xsite-out main, .xsite-out .site-footer { opacity: 0; }
@media (prefers-reduced-motion: reduce) { @view-transition { navigation: none; } }
`;

/** Served as /site.js and loaded (blocking) from <head>: picks the theme
 *  before first paint (from the cookie blockworked.com shares, then the OS),
 *  runs the theme toggle, and fades between the two sites. They're separate
 *  origins, so CSS cross-document view transitions don't reach across: the
 *  page fades out before following a link to the other site and leaves a
 *  short-lived cookie, and the other side fades in when it finds it. */
export const SITE_JS = `(function () {
  var root = document.documentElement;
  var domain = /(^|\\.)blockworked\\.com$/.test(location.hostname) ? '; domain=blockworked.com' : '';

  var m = document.cookie.match(/(?:^|; )bw-theme=(light|dark)/);
  root.dataset.theme = m ? m[1] : window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.theme-toggle')) return;
    var next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    document.cookie = 'bw-theme=' + next + '; path=/; max-age=31536000; samesite=lax' + domain;
  });

  // The language both sites show; the main site keeps it in its paths too.
  document.addEventListener('change', function (e) {
    if (!e.target.matches || !e.target.matches('[data-language-picker]')) return;
    document.cookie = 'bw-lang=' + e.target.value + '; path=/; max-age=31536000; samesite=lax' + domain;
    location.reload();
  });

  var arriving = /(?:^|; )bw-xsite=1/.test(document.cookie);
  if (arriving) document.cookie = 'bw-xsite=; path=/; max-age=0' + domain;
  if (!window.matchMedia || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (arriving) {
    root.classList.add('xsite-in');
    var reveal = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { root.classList.remove('xsite-in'); });
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reveal);
    else reveal();
  }
  function isSister(u) {
    var h = u.hostname;
    return u.origin !== location.origin &&
      (h === 'blockworked.com' || /\\.blockworked\\.com$/.test(h) || h === location.hostname);
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    var u = new URL(a.href, location.href);
    if (!isSister(u)) return;
    e.preventDefault();
    document.cookie = 'bw-xsite=1; path=/; max-age=10; samesite=lax' + domain;
    root.classList.add('xsite-out');
    setTimeout(function () { location.href = u.href; }, 180);
  });
  // Coming back with the Back button can restore the faded-out page.
  addEventListener('pageshow', function (e) {
    if (e.persisted) root.classList.remove('xsite-out', 'xsite-in');
  });
})();
`;

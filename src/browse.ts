// Browsing the library: search and filters on the home page, a page per pack
// with its blocks, versions and comments, its source, and a page per author.

import type { User } from "./auth.ts";
import type { Env } from "./index.ts";
import { capabilityList, esc, message, page, verifiedBadge } from "./pages.ts";
import { blockView, CAPABILITIES, OFFICIAL_OWNER } from "./packs.ts";
import { highlightJson, packSource } from "./source.ts";
import { backgroundRenders, blockPicture, blockPictures, viewer } from "./renders.ts";
import { commentsSection } from "./comments.ts";

export interface VersionRow {
  id: number;
  pack_id: string;
  sha256: string;
  name: string;
  description: string;
  version: string;
  blocks: string;
  block_views: string;
  /** Pictures of its blocks (renders.ts), or "". */
  renders: string;
  capabilities: string;
  status: string;
  reason: string;
  submitted_by: string;
  submitted_at: number;
  reviewed_at?: number | null;
  author: string;
  /** Only set by queries that join the pack's owner. */
  owner_id?: string;
}

/** A listed pack's newest approved version, with what the list shows about it. */
export interface ListedPack extends VersionRow {
  owner_id: string;
  author_public_id: string;
  author_avatar: string;
  pack_created_at: number;
  comments: number;
}

const LISTED = `SELECT v.*, u.name AS author, u.public_id AS author_public_id, u.avatar AS author_avatar,
       p.owner_id AS owner_id, p.created_at AS pack_created_at,
       (SELECT COUNT(*) FROM comments c JOIN users cu ON cu.id = c.user_id
        WHERE c.pack_id = p.id AND c.deleted_at IS NULL AND cu.banned = 0) AS comments
     FROM versions v JOIN packs p ON p.id = v.pack_id JOIN users u ON u.id = p.owner_id
     WHERE p.listed = 1 AND u.banned = 0
       AND v.id = (SELECT MAX(id) FROM versions WHERE pack_id = p.id AND status = 'approved')`;

/** Each listed pack's newest approved version. */
export async function published(env: Env): Promise<ListedPack[]> {
  const { results } = await env.DB.prepare(`${LISTED} ORDER BY v.name COLLATE NOCASE`).all<ListedPack>();
  return withBlockViews(env, results);
}

export async function listedPack(env: Env, id: string): Promise<ListedPack | null> {
  const p = await env.DB.prepare(`${LISTED} AND p.id = ?`).bind(id).first<ListedPack>();
  return p && (await withBlockViews(env, [p]))[0];
}

/** Fills in block_views for versions saved before the site kept them, from their pack files, once. */
export async function withBlockViews<T extends { id: number; sha256: string; block_views: string }>(env: Env, rows: T[]): Promise<T[]> {
  const missing = rows.filter((v) => !v.block_views);
  if (!missing.length) return rows;
  const updates: D1PreparedStatement[] = [];
  await Promise.all(
    missing.map(async (v) => {
      const object = await env.PACKS.get(`packs/${v.sha256}.json`);
      if (!object) return;
      try {
        const defs = JSON.parse(await object.text())?.blocks?.block_defs;
        if (!Array.isArray(defs)) return;
        v.block_views = JSON.stringify(defs.map(blockView));
        updates.push(env.DB.prepare("UPDATE versions SET block_views = ? WHERE id = ?").bind(v.block_views, v.id));
      } catch {}
    }),
  );
  if (updates.length) await env.DB.batch(updates);
  return rows;
}


// Search and filters

export const SORTS = [
  ["match", "Best match"],
  ["name", "Name"],
  ["updated", "Recently updated"],
  ["new", "Newest"],
  ["discussed", "Most discussed"],
] as const;
export type Sort = (typeof SORTS)[number][0];

export interface Filters {
  q: string;
  /** "" for any, "none" for no permissions, "safe" for nothing risky, or a capability kind the pack uses. */
  uses: string;
  official: boolean;
  sort: Sort;
}

export function readFilters(params: URLSearchParams): Filters {
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const uses = params.get("uses") ?? "";
  const sort = params.get("sort") ?? "";
  return {
    q,
    uses: uses === "none" || uses === "safe" || CAPABILITIES.some(([k]) => k === uses) ? uses : "",
    official: params.get("official") === "1",
    sort: SORTS.some(([s]) => s === sort) ? (sort as Sort) : q ? "match" : "name",
  };
}

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** How well a pack matches every word of the query, or 0 if one word is missing. Names count most. */
export function matchScore(p: Pick<VersionRow, "name" | "description" | "blocks" | "author" | "pack_id">, q: string): number {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  const name = fold(`${p.name} ${p.pack_id}`);
  const blocks = fold((JSON.parse(p.blocks) as string[]).join(" "));
  const rest = fold(`${p.description} ${p.author}`);
  let score = 0;
  for (const t of terms) {
    const s = (name.includes(t) ? 4 : 0) + (blocks.includes(t) ? 2 : 0) + (rest.includes(t) ? 1 : 0);
    if (!s) return 0;
    score += s;
  }
  return score;
}

export function filterPacks<T extends ListedPack>(packs: T[], f: Filters): T[] {
  const risky = new Set(CAPABILITIES.filter(([, , r]) => r).map(([k]) => k));
  const scored = packs
    .map((p) => ({ p, score: matchScore(p, f.q), caps: JSON.parse(p.capabilities) as string[] }))
    .filter(({ p, score, caps }) => {
      if (!score) return false;
      if (f.official && p.owner_id !== OFFICIAL_OWNER) return false;
      if (f.uses === "none") return caps.length === 0;
      if (f.uses === "safe") return !caps.some((c) => risky.has(c));
      return !f.uses || caps.includes(f.uses);
    });
  const byName = (a: { p: T }, b: { p: T }) => a.p.name.localeCompare(b.p.name, "en", { sensitivity: "base" });
  const order: Record<Sort, (a: { p: T; score: number }, b: { p: T; score: number }) => number> = {
    match: (a, b) => b.score - a.score || byName(a, b),
    name: byName,
    updated: (a, b) => b.p.submitted_at - a.p.submitted_at || byName(a, b),
    new: (a, b) => b.p.pack_created_at - a.p.pack_created_at || byName(a, b),
    discussed: (a, b) => b.p.comments - a.p.comments || byName(a, b),
  };
  return scored.sort(order[f.sort]).map(({ p }) => p);
}

// Pieces

export function date(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function authorLink(name: string, publicId: string | null | undefined, official: boolean): string {
  const label = `${esc(name)}${official ? verifiedBadge() : ""}`;
  return publicId ? `<a class="author" href="/authors/${encodeURIComponent(publicId)}">${label}</a>` : label;
}

// Lucide's arrow-left and chevron-right, drawn like the site nav's icons.
const LUCIDE = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const BACK = `<svg ${LUCIDE} width="15" height="15"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
export const CHECK = `<svg ${LUCIDE}><path d="M20 6 9 17l-5-5"/></svg>`;
export const PEN = `<svg ${LUCIDE}><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>`;
const CHEVRON = `<svg ${LUCIDE} width="13" height="13" class="chevron"><path d="m9 18 6-6-6-6"/></svg>`;
const COMMENT_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

export function listedCard(p: ListedPack): string {
  const href = `/packs/${encodeURIComponent(p.pack_id)}`;
  const count = (JSON.parse(p.blocks) as string[]).length;
  return `<article class="card pack">
    <div class="pack-head"><h3><a href="${href}">${esc(p.name)}</a> <span class="version">${esc(p.version)}</span></h3>
      ${p.comments ? `<a class="count" href="${href}#comments" title="${plural(p.comments, "comment")}">${COMMENT_ICON}${p.comments}</a>` : ""}</div>
    <p class="muted by meta"><span>by ${authorLink(p.author, p.author_public_id, p.owner_id === OFFICIAL_OWNER)}</span><span>${plural(count, "block")}</span><span>updated ${date(p.submitted_at)}</span></p>
    <p>${esc(p.description)}</p>${blockPictures(p)}${capabilityList(JSON.parse(p.capabilities))}</article>`;
}

function select(name: string, current: string, options: readonly (readonly [string, string])[]): string {
  return `<select name="${name}">${options
    .map(([v, l]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(l)}</option>`)
    .join("")}</select>`;
}

function filterForm(f: Filters): string {
  const uses: [string, string][] = [
    ["", "Any permissions"],
    ["none", "Needs no permissions"],
    ["safe", "Nothing risky"],
    ...CAPABILITIES.map(([k, label]): [string, string] => [k, label]),
  ];
  return `<form class="filters" method="get" action="/" role="search">
    <div class="search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5l3.2 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input type="search" name="q" value="${esc(f.q)}" placeholder="Search packs, blocks and authors" aria-label="Search packs" maxlength="100"></div>
    <div class="filter-row">
      <label><span class="sr">Permissions</span>${select("uses", f.uses, uses)}</label>
      <label><span class="sr">Sort by</span>${select("sort", f.sort, SORTS)}</label>
      <label class="check"><input type="checkbox" name="official" value="1"${f.official ? " checked" : ""}> Official only</label>
      <button class="primary">Search</button>
    </div></form>`;
}

// Pages

export async function home(env: Env, user: User | null, admin: boolean, params: URLSearchParams): Promise<Response> {
  const f = readFilters(params);
  const all = await published(env);
  const shown = filterPacks(all, f);
  const filtered = !!(f.q || f.uses || f.official);
  const summary = filtered
    ? `<p class="results muted meta"><span>${plural(shown.length, "pack")} of ${all.length}</span><a href="/">Clear filters</a></p>`
    : `<p class="results muted">${plural(all.length, "pack")}</p>`;
  const list = shown.length
    ? shown.map(listedCard).join("")
    : `<div class="empty"><p>${filtered ? "No packs match that." : "No packs yet."}</p>${filtered ? `<p><a href="/">See every pack</a></p>` : ""}</div>`;
  return page(
    f.q ? `Search: ${f.q}` : "Packs",
    user,
    admin,
    `<section class="hero"><h1>Community blocks</h1>
     <p>Packs of blocks people made for Blockwork.</p>
     <p class="actions"><a class="button primary large" href="/submit">Submit a pack</a><span>Install packs in Blockwork from <kbd>My Blocks${CHEVRON}Browse</kbd></span></p></section>
     ${filterForm(f)}${summary}<div class="pack-list">${list}</div>${await backgroundRenders(env, admin)}`,
  );
}

async function approvedVersions(env: Env, packId: string): Promise<VersionRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT v.*, '' AS author FROM versions v WHERE pack_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 50",
  )
    .bind(packId)
    .all<VersionRow>();
  return results;
}

async function packJson(env: Env, sha: string): Promise<string | null> {
  const object = await env.PACKS.get(`packs/${sha}.json`);
  return object ? object.text() : null;
}

function parse(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function inputsTable(inputs: { name: string; type: string; default: string }[]): string {
  if (!inputs.length) return "";
  return `<dl class="inputs">${inputs
    .map((i) => `<div><dt>${esc(i.name)}</dt><dd>${esc(i.type === "Bool" ? "true or false" : "any value")}${i.default ? `, starts as <code>${esc(i.default)}</code>` : ""}</dd></div>`)
    .join("")}</dl>`;
}

function packHeader(p: ListedPack, current: "overview" | "source", versionNote = ""): string {
  const base = `/packs/${encodeURIComponent(p.pack_id)}`;
  const tab = (key: string, href: string, label: string) =>
    `<a href="${href}"${key === current ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<p class="crumbs"><a href="/">${BACK}All packs</a></p>
    <div class="pack-title"><h1>${esc(p.name)} <span class="version">${esc(p.version)}</span></h1>
      <p class="actions"><a class="button" href="/packs/${p.sha256}.json" download="${esc(p.pack_id)}.blockpack">Download</a></p></div>
    <p class="muted by meta"><span>by ${authorLink(p.author, p.author_public_id, p.owner_id === OFFICIAL_OWNER)}</span><span>updated ${date(p.submitted_at)}</span><span>first shared ${date(p.pack_created_at)}</span>${versionNote}</p>
    <nav class="tabs" aria-label="Pack">${tab("overview", base, "Overview")}${tab("source", `${base}/source`, "Source")}${tab("comments", `${base}#comments`, `Comments <span class="n">${p.comments}</span>`)}</nav>`;
}

export async function packPage(env: Env, user: User | null, admin: boolean, id: string, error = "", draft = ""): Promise<Response> {
  const p = await listedPack(env, id);
  if (!p) return message(user, admin, "Not found", "That pack isn't in the library.", 404);
  const [text, versions] = await Promise.all([packJson(env, p.sha256), approvedVersions(env, p.pack_id)]);
  const blocks = packSource(parse(text));
  const blockList = blocks
    .map(
      (b) => `<li class="block-item"><div class="block-name">${blockPicture(p, b.id) || `<strong>${esc(b.name)}</strong>`}</div>
        ${b.description ? `<p>${esc(b.description)}</p>` : ""}${inputsTable(b.inputs)}</li>`,
    )
    .join("");
  const versionList = versions
    .map(
      (v, i) => `<li><span class="v">${esc(v.version || v.sha256.slice(0, 8))}</span>${i === 0 ? ` <span class="mark latest">${CHECK}latest</span>` : ""}
        <span class="muted">${date(v.reviewed_at ?? v.submitted_at)}</span>
        <span class="links"><a href="/packs/${encodeURIComponent(p.pack_id)}/source?v=${v.sha256}">source</a> <a href="/packs/${v.sha256}.json" download="${esc(p.pack_id)}-${esc(v.version || v.sha256.slice(0, 8))}.blockpack">file</a></span></li>`,
    )
    .join("");
  return page(
    p.name,
    user,
    admin,
    `${packHeader(p, "overview")}
     <p class="lede">${esc(p.description)}</p>
     <p class="hint">To add it, open Blockwork and go to My Blocks &gt; Browse library.</p>
     <h2>What it can do</h2>${capabilityList(JSON.parse(p.capabilities))}
     <h2>${plural(blocks.length, "block")}</h2><ul class="block-list">${blockList}</ul>
     <p class="see-how"><a href="/packs/${encodeURIComponent(p.pack_id)}/source">See how they work</a></p>
     <h2>Versions</h2><ul class="versions">${versionList}</ul>
     ${await commentsSection(env, user, admin, p, error, draft)}${await backgroundRenders(env, admin)}`,
  );
}

/** The pack in Blockwork's editor, or the file as JSON; shared by the source page and the review page. */
export function sourceView(
  env: Env,
  text: string | null,
  view: "blocks" | "json",
  links: { blocks: string; json: string; file: string; render?: string },
  title: string,
): string {
  const tabs = `<nav class="tabs small" aria-label="Source view">
    <a href="${links.blocks}"${view === "blocks" ? ` aria-current="page"` : ""}>Blocks</a>
    <a href="${links.json}"${view === "json" ? ` aria-current="page"` : ""}>Pack file</a>
    <a class="end" href="${links.file}">Raw</a></nav>`;
  if (text === null) return `${tabs}<p class="muted">The pack file is missing.</p>`;
  if (view === "json") return `${tabs}<pre class="code"><code>${highlightJson(text.slice(0, 400_000))}</code></pre>`;
  return `${tabs}${viewer(env, links.file, title, links.render)}`;
}

export async function sourcePage(env: Env, user: User | null, admin: boolean, id: string, params: URLSearchParams): Promise<Response> {
  const p = await listedPack(env, id);
  if (!p) return message(user, admin, "Not found", "That pack isn't in the library.", 404);
  let sha = p.sha256;
  let note = "";
  const asked = params.get("v");
  if (asked && asked !== p.sha256) {
    const old = await env.DB.prepare("SELECT version FROM versions WHERE pack_id = ? AND sha256 = ? AND status = 'approved'")
      .bind(p.pack_id, asked)
      .first<{ version: string }>();
    if (!old) return message(user, admin, "Not found", "That version isn't in the library.", 404);
    sha = asked;
    note = `<span>showing version ${esc(old.version || asked.slice(0, 8))} (<a href="/packs/${encodeURIComponent(p.pack_id)}/source">see current</a>)</span>`;
  }
  const view = params.get("view") === "json" ? "json" : "blocks";
  const base = `/packs/${encodeURIComponent(p.pack_id)}/source${sha === p.sha256 ? "" : `?v=${sha}`}`;
  const json = `${base}${base.includes("?") ? "&" : "?"}view=json`;
  return page(
    `${p.name} source`,
    user,
    admin,
    `${packHeader(p, "source", note)}${sourceView(env, await packJson(env, sha), view, { blocks: base, json, file: `/packs/${sha}.json` }, `${p.name} in Blockwork's editor`)}`,
  );
}

export async function authorPage(env: Env, user: User | null, admin: boolean, publicId: string): Promise<Response> {
  const author = await env.DB.prepare("SELECT id, name, avatar, username, created_at FROM users WHERE public_id = ? AND banned = 0")
    .bind(publicId)
    .first<{ id: string; name: string; avatar: string; username: string | null; created_at: number }>();
  if (!author) return message(user, admin, "Not found", "There's no one here by that name.", 404);
  const { results } = await env.DB.prepare(`${LISTED} AND p.owner_id = ? ORDER BY v.submitted_at DESC`).bind(author.id).all<ListedPack>();
  const official = author.id === OFFICIAL_OWNER;
  const avatar = author.avatar ? `<img class="avatar large" src="${esc(author.avatar)}" alt="">` : "";
  return page(
    author.name,
    user,
    admin,
    `<p class="crumbs"><a href="/">${BACK}All packs</a></p>
     <div class="profile">${avatar}<div><h1>${esc(author.name)}${official ? verifiedBadge() : ""}</h1>${author.username ? `<p class="muted">@${esc(author.username)}</p>` : ""}
     <p class="muted">${official ? "The Blockworked team's official packs." : `Sharing blocks since ${date(author.created_at)}.`} ${plural(results.length, "pack")}.</p></div></div>
     <div class="pack-list">${results.map(listedCard).join("") || `<p class="muted">No packs listed yet.</p>`}</div>`,
  );
}

/** A pack version as a card in the admin and "My packs" lists. */
export function packCard(v: VersionRow, extra = ""): string {
  return `<div class="card"><h3>${esc(v.name)} <span class="version">${esc(v.version)}</span></h3>
    <p class="muted by">by ${esc(v.author)}${v.owner_id === OFFICIAL_OWNER ? verifiedBadge() : ""}</p><p>${esc(v.description)}</p>
    ${blockPictures(v)}${capabilityList(JSON.parse(v.capabilities))}${extra}</div>`;
}

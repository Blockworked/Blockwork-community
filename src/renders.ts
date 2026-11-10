// Blocks as Blockwork's own editor draws them. The site never draws a block
// itself: a pack's source is shown in the pack viewer (blockworked.com's web
// build of the editor, qt-demo/PackView.qml there, in an iframe), and the
// lists show pictures that same viewer drew, which an admin's browser saves
// when it opens the version for review, or any page while some are missing.

import type { User } from "./auth.ts";
import type { Env } from "./index.ts";
import { esc, page } from "./pages.ts";
import { packSource } from "./source.ts";

export interface Rendered {
  id: string;
  name: string;
  width: number;
  height: number;
  /** "webp", or absent for the PNGs every version had before. */
  format?: "webp";
}

export interface Renders {
  at: number;
  blocks: Rendered[];
}

export function parseRenders(text: string | null | undefined): Renders | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text);
    return r && Array.isArray(r.blocks) ? r : null;
  } catch {
    return null;
  }
}

export function viewerUrl(env: Env): string {
  return `${new URL(env.MAIN_SITE_URL || "https://blockworked.com").origin}/packview/`;
}

function picture(sha: string, at: number, b: Rendered): string {
  const src = (theme: string) => `/renders/${sha}/${encodeURIComponent(b.id)}.${theme}.${b.format ?? "png"}?at=${at}`;
  const img = (theme: string) =>
    `<img class="on-${theme}" src="${src(theme)}" width="${b.width}" height="${b.height}" alt="${esc(b.name)}" loading="lazy">`;
  return `${img("dark")}${img("light")}`;
}

/** A version's blocks as pictures, or their names until it has some. */
export function blockPictures(v: { sha256: string; blocks: string; renders?: string | null }): string {
  const r = parseRenders(v.renders);
  if (r && r.blocks.length) return `<div class="blocks">${r.blocks.map((b) => picture(v.sha256, r.at, b)).join("")}</div>`;
  const names = JSON.parse(v.blocks) as string[];
  return `<ul class="block-names">${names.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
}

/** One block's picture, or "" when there isn't one. */
export function blockPicture(v: { sha256: string; renders?: string | null }, id: string): string {
  const r = parseRenders(v.renders);
  const b = r?.blocks.find((x) => x.id === id);
  return r && b ? `<div class="blocks">${picture(v.sha256, r.at, b)}</div>` : "";
}

/**
 * The pack viewer in an iframe, showing the pack file at `packUrl` (site.js
 * hands it over; see browse.js). With `renderTo`, it also draws the blocks
 * and posts the pictures there.
 */
export function viewer(env: Env, packUrl: string, title: string, renderTo = ""): string {
  const jobs = JSON.stringify([{ pack: packUrl, render: renderTo }]);
  return `<div class="viewer"><iframe class="pack-viewer" src="${esc(viewerUrl(env))}" title="${esc(title)}"
    data-jobs="${esc(jobs)}" loading="lazy" referrerpolicy="origin"></iframe></div>
    <p class="viewer-note">Blockwork's editor, read-only. Drag to look around; zoom with the buttons or Ctrl and the scroll wheel.
    <noscript>It needs JavaScript; the pack file tab shows the same blocks as text.</noscript></p>
    <script src="/browse.js" defer></script>
    ${renderTo ? `<p class="render-status" data-render-status></p>` : ""}`;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const MAX_PICTURE = 512 * 1024;
const MAX_UPLOAD = 16 * 1024 * 1024;

type Picture = { bytes: Uint8Array; format: "png" | "webp" };
const TYPES = { png: "image/png", webp: "image/webp" } as const;

/** A base64 PNG or WebP. */
export function decodePicture(base64: unknown): Picture | null {
  if (typeof base64 !== "string" || base64.length > (MAX_PICTURE * 4) / 3 + 4) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (PNG.every((b, i) => bytes[i] === b)) return { bytes, format: "png" };
  if (RIFF.every((b, i) => bytes[i] === b) && WEBP.every((b, i) => bytes[i + 8] === b)) return { bytes, format: "webp" };
  return null;
}

const size = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 && (n as number) <= 4000 ? (n as number) : 0);

/** POST /admin/versions/<id>/renders: the viewer's pictures of each block, as {blocks: [{id, width, height, dark, light}]}. */
export async function saveRenders(req: Request, env: Env, versionId: number): Promise<Response> {
  const v = await env.DB.prepare("SELECT sha256 FROM versions WHERE id = ?").bind(versionId).first<{ sha256: string }>();
  const file = v ? await env.PACKS.get(`packs/${v.sha256}.json`) : null;
  if (!v || !file) return Response.json({ error: "That version doesn't exist." }, { status: 404 });
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_UPLOAD) return Response.json({ error: "Too big." }, { status: 413 });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  let pack: unknown = null;
  try {
    pack = JSON.parse(await file.text());
  } catch {}
  const defs = new Map(packSource(pack).map((b) => [b.id, b.name]));
  const blocks: Rendered[] = [];
  const puts: Promise<unknown>[] = [];
  for (const b of Array.isArray(body?.blocks) ? body.blocks : []) {
    const id = String(b?.id ?? "");
    const width = size(b?.width);
    const height = size(b?.height);
    const dark = decodePicture(b?.dark);
    const light = decodePicture(b?.light);
    if (!defs.has(id) || !width || !height || !dark || !light || dark.format !== light.format || blocks.some((x) => x.id === id)) {
      return Response.json({ error: `A picture for "${id}" isn't one this pack's blocks can have.` }, { status: 400 });
    }
    const format = dark.format;
    blocks.push({ id, name: defs.get(id)!, width, height, ...(format === "webp" ? { format } : {}) });
    for (const [theme, picture] of [["dark", dark], ["light", light]] as const) {
      puts.push(env.PACKS.put(`renders/${v.sha256}/${id}.${theme}.${format}`, picture.bytes, { httpMetadata: { contentType: TYPES[format] } }));
    }
  }
  if (!blocks.length) return Response.json({ error: "No pictures." }, { status: 400 });
  await Promise.all(puts);
  const renders: Renders = { at: Date.now(), blocks };
  // Every version uploaded as this exact file shares the pictures.
  await env.DB.prepare("UPDATE versions SET renders = ? WHERE sha256 = ?").bind(JSON.stringify(renders), v.sha256).run();
  return Response.json({ saved: blocks.length });
}

/** GET /renders/<sha>/<id>.<theme>.<png|webp>: anyone for a listed version, admins for any. */
export async function renderFile(env: Env, admin: boolean, sha: string, id: string, theme: string, format: "png" | "webp" = "png"): Promise<Response> {
  if (!admin) {
    const ok = await env.DB.prepare(
      `SELECT 1 FROM versions v JOIN packs p ON p.id = v.pack_id JOIN users u ON u.id = p.owner_id WHERE v.sha256 = ? AND v.status = 'approved' AND p.listed = 1 AND u.deactivated_at = 0 AND u.deleted_at = 0`,
    )
      .bind(sha)
      .first();
    if (!ok) return new Response("Not found", { status: 404 });
  }
  const object = await env.PACKS.get(`renders/${sha}/${id}.${theme}.${format}`);
  if (!object) return new Response("Not found", { status: 404 });
  // The URL carries the render time, so a new render is a new URL.
  return new Response(object.body, { headers: { "Content-Type": TYPES[format], "Cache-Control": "public, max-age=31536000, immutable" } });
}

async function unrendered(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, version, sha256 FROM versions WHERE renders = '' AND status IN ('approved', 'pending') ORDER BY id DESC LIMIT 200`,
  ).all<{ id: number; name: string; version: string; sha256: string }>();
  return results;
}

const jobsFor = (versions: { id: number }[]) =>
  JSON.stringify(versions.map((v) => ({ pack: `/admin/versions/${v.id}/file`, render: `/admin/versions/${v.id}/renders` })));

/** For an admin's pages: an offscreen viewer that draws any version still without pictures, or "". */
export async function backgroundRenders(env: Env, admin: boolean): Promise<string> {
  if (!admin) return "";
  const missing = await unrendered(env);
  if (!missing.length) return "";
  return `<div class="viewer offscreen" aria-hidden="true"><iframe class="pack-viewer" src="${esc(viewerUrl(env))}" tabindex="-1"
    title="Pack viewer" data-jobs="${esc(jobsFor(missing))}" referrerpolicy="origin"></iframe></div><script src="/browse.js" defer></script>`;
}

/** GET /admin/renders: draws every version still without pictures, one after another, in this page. */
export async function rendersPage(env: Env, user: User, admin: boolean): Promise<Response> {
  const results = await unrendered(env);
  const redraw = `<form method="post" action="/admin/renders/redraw"><p><button>Redraw every picture</button></p></form>`;
  if (!results.length) {
    return page("Block pictures", user, admin, `<h1>Block pictures</h1><p>Every version has its pictures.</p>${redraw}`);
  }
  return page(
    "Block pictures",
    user,
    admin,
    `<h1>Block pictures</h1>
     <p>${results.length} version${results.length === 1 ? "" : "s"} without pictures of ${results.length === 1 ? "its" : "their"} blocks:
     ${results.map((v) => esc(`${v.name} ${v.version}`)).join(", ")}. Keep this page open while Blockwork's editor draws them.</p>
     <div class="viewer"><iframe class="pack-viewer" src="${esc(viewerUrl(env))}" title="Pack viewer" data-jobs="${esc(jobsFor(results))}" referrerpolicy="origin"></iframe></div>
     <p class="render-status" data-render-status></p><script src="/browse.js" defer></script>`,
  );
}

/** POST /admin/renders/redraw (all) or /admin/versions/<id>/redraw (one): forgets pictures so they're drawn again. */
export async function redraw(env: Env, versionId?: number): Promise<Response> {
  if (versionId === undefined) {
    await env.DB.prepare("UPDATE versions SET renders = ''").run();
    return new Response(null, { status: 303, headers: { Location: "/admin/renders" } });
  }
  const v = await env.DB.prepare("SELECT sha256 FROM versions WHERE id = ?").bind(versionId).first<{ sha256: string }>();
  if (v) await env.DB.prepare("UPDATE versions SET renders = '' WHERE sha256 = ?").bind(v.sha256).run();
  return new Response(null, { status: 303, headers: { Location: `/admin/versions/${versionId}#file` } });
}

/** Served as /browse.js: hands packs to the viewer iframes and saves what they render. */
export const BROWSE_JS = `(function () {
  var root = document.documentElement;
  // The viewer draws at 2x the screen's own scale; keep 2x and save WebP
  // (about a fifth of the PNG) where the browser can write it.
  function shrink(png, width, height) {
    if (typeof OffscreenCanvas === 'undefined' || !window.createImageBitmap) return Promise.resolve(png);
    // Decoded by hand: the page's CSP doesn't let fetch() read data: URLs.
    var raw = atob(png), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      .then(function (bitmap) {
        var w = Math.min(bitmap.width, width * 2), h = Math.min(bitmap.height, height * 2);
        var canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(bitmap, 0, 0, w, h);
        return canvas.convertToBlob({ type: 'image/webp', quality: 0.95 });
      })
      .then(function (blob) {
        if (blob.type !== 'image/webp') return png;
        return blob.arrayBuffer().then(function (buffer) {
          var bytes = new Uint8Array(buffer), text = '';
          for (var i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(text);
        });
      })
      .catch(function () { return png; });
  }
  function compact(blocks) {
    return Promise.all(blocks.map(function (b) {
      if (!b.dark || !b.light) return b;
      return Promise.all([shrink(b.dark, b.width, b.height), shrink(b.light, b.width, b.height)]).then(function (both) {
        // Both themes in one format, or both left as PNG.
        var webp = both[0] !== b.dark && both[1] !== b.light;
        return Object.assign({}, b, webp ? { dark: both[0], light: both[1] } : {});
      });
    }));
  }
  var theme = function () { return root.dataset.theme === 'light' ? 'light' : 'dark'; };
  document.querySelectorAll('iframe.pack-viewer').forEach(function (frame) {
    var origin = new URL(frame.src).origin;
    var jobs = JSON.parse(frame.dataset.jobs || '[]');
    var status = document.querySelector('[data-render-status]');
    var job = null, done = 0, started = false;
    var say = function (text) { if (status) status.textContent = text; };
    var post = function (message) { frame.contentWindow.postMessage(message, origin); };
    function next() {
      job = jobs.shift();
      if (!job) { if (done) say(done === 1 ? 'Saved the block pictures.' : 'Saved pictures for ' + done + ' versions.'); return; }
      fetch(job.pack, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('Couldn\\'t load the pack file.'); return r.text(); })
        .then(function (pack) {
          post({ type: 'blockwork-pack', pack: pack, theme: theme() });
          if (job.render) { say('Drawing the blocks...'); post({ type: 'blockwork-render' }); }
        })
        .catch(function (e) { say(e.message); next(); });
    }
    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      var m = event.data || {};
      if (m.type === 'blockwork-ready' && !started) { started = true; next(); }
      else if (m.type === 'blockwork-failed') { say(m.reason || 'The viewer stopped.'); }
      else if (m.type === 'blockwork-rendered' && job && job.render) {
        compact(m.blocks)
          .then(function (blocks) { return fetch(job.render, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks: blocks }) }); })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (body) { if (!r.ok) throw new Error(body.error || 'Couldn\\'t save the pictures.'); }); })
          .then(function () { done++; next(); })
          .catch(function (e) { say(e.message); next(); });
      }
    });
    new MutationObserver(function () { if (started) post({ type: 'blockwork-theme', theme: theme() }); })
      .observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  });
})();
`;

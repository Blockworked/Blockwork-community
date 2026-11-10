import { notify } from "./notifications.ts";
// What Blockwork's Block library talks to: sign-in through the browser
// (a loopback redirect with PKCE), then JSON over a bearer token for pack
// pages, comments, the signed-in account's packs and uploads.

import { cookies, hash, isAdmin, isReservedName, randomToken, type User } from "./auth.ts";
import type { Env } from "./index.ts";
import { esc, page } from "./pages.ts";
import { OFFICIAL_OWNER, readPack, sha256Hex, stampPack, type PackMeta } from "./packs.ts";
import { listedPack, withBlockViews } from "./browse.ts";
import { addComment, canDelete, listComments, removeComment } from "./comments.ts";

const APP_SESSION_DAYS = 365;
const CODE_MINUTES = 5;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const fail = (error: string, status = 400) => json({ error }, status);

/** The account behind an `Authorization: Bearer` token Blockwork got from signing in. */
export async function bearerUser(req: Request, env: Env): Promise<User | null> {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const user = await env.DB.prepare(
    "SELECT u.id, u.name, u.avatar, u.banned FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.kind = 'app'",
  )
    .bind(await hash(m[1]), Date.now())
    .first<User>();
  return user && (user.banned || (isReservedName(user.name) && !isAdmin(env, user))) ? null : user;
}

// Sign-in

interface LoginAsk {
  port: number;
  state: string;
  challenge: string;
  label: string;
}

/** The app's request, or null if anything in it is off. */
export function readLoginAsk(params: URLSearchParams | FormData): LoginAsk | null {
  const get = (k: string) => String(params.get(k) ?? "");
  const port = Number(get("port"));
  const state = get("state");
  const challenge = get("challenge");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  // The computer's name, so the account page can tell sign-ins apart.
  const label = get("label").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  return { port, state, challenge, label };
}

function loopback(ask: LoginAsk, query: Record<string, string>): string {
  return `http://127.0.0.1:${ask.port}/callback?${new URLSearchParams({ ...query, state: ask.state })}`;
}

/** GET /app/login: asks the signed-in account whether Blockwork may act for it. */
export function appLoginPage(user: User | null, url: URL): Response {
  const ask = readLoginAsk(url.searchParams);
  if (!ask) return page("Sign in to Blockwork", user, false, `<h1>Sign in to Blockwork</h1><p>That sign-in link isn't right. Start again from Blockwork.</p>`, 400);
  if (!user) {
    return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
  }
  const hidden = Object.entries({ port: String(ask.port), state: ask.state, challenge: ask.challenge, label: ask.label })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  const res = page(
    "Sign in to Blockwork",
    user,
    false,
    `<section class="app-signin"><h1>Sign in to Blockwork?</h1>
     <p>Blockwork${ask.label ? ` on <strong>${esc(ask.label)}</strong>` : ""} is asking to use your account, <strong>${esc(user.name)}</strong>.</p>
     <p>It will be able to share packs and updates to them, and post and delete your comments. You can sign it out from Blockwork at any time.</p>
     <form method="post" action="/app/login">${hidden}
       <p class="actions"><button class="primary large">Sign in</button>
       <a class="button large" href="${esc(loopback(ask, { error: "denied" }))}">Cancel</a></p></form>
     <p class="muted">Only continue if you just asked Blockwork to sign in.</p></section>`,
  );
  // The form's answer goes to Blockwork's address on this computer.
  res.headers.set("X-Loopback-Form", "1");
  return res;
}

/** POST /app/login: makes a one-time code and hands it to the app. */
export async function appLoginConfirm(req: Request, env: Env, user: User | null): Promise<Response> {
  const ask = readLoginAsk(await req.formData());
  if (!ask) return page("Sign in to Blockwork", user, false, `<h1>Sign in to Blockwork</h1><p>That sign-in link isn't right. Start again from Blockwork.</p>`, 400);
  if (!user) return new Response(null, { status: 303, headers: { Location: "/login" } });
  const code = randomToken();
  const sessionHashes = await Promise.all(cookies(req, "session").slice(0, 2).map(hash));
  const result = await env.DB.prepare(`INSERT INTO app_codes (code_hash, user_id, challenge, label, expires_at, auth_version)
    SELECT ?, u.id, ?, ?, ?, u.auth_version FROM users u WHERE u.id = ? AND u.banned = 0
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.kind = 'web' AND s.expires_at > ? AND s.token_hash IN (?, ?))`)
    .bind(await hash(code), ask.challenge, ask.label, Date.now() + CODE_MINUTES * 60_000, user.id, Date.now(), sessionHashes[0] ?? "", sessionHashes[1] ?? "").run();
  if (result.meta.changes !== 1) return new Response(null, {status: 303, headers: {Location: "/login"}});
  return new Response(null, { status: 303, headers: { Location: loopback(ask, { code }) } });
}

/** base64url of SHA-256, as PKCE's S256 has it. */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function profile(env: Env, user: User) {
  const row = await env.DB.prepare("SELECT public_id FROM users WHERE id = ?").bind(user.id).first<{ public_id: string | null }>();
  return {
    name: user.name,
    avatar: user.avatar,
    id: row?.public_id ?? "",
    page: row?.public_id ? `${env.SITE_URL}/authors/${row.public_id}` : "",
    official: user.id === OFFICIAL_OWNER,
    banned: !!user.banned,
  };
}

/** POST /api/v1/app/token: swaps the code and verifier for a token. */
async function token(req: Request, env: Env): Promise<Response> {
  const { code, verifier } = await body(req);
  if (typeof code !== "string" || typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return fail("That sign-in didn't work. Try again.");
  }
  const row = await env.DB.prepare("DELETE FROM app_codes WHERE code_hash = ? RETURNING user_id, challenge, label, expires_at, auth_version")
    .bind(await hash(code))
    .first<{ user_id: string; challenge: string; label: string; expires_at: number; auth_version: number }>();
  if (!row || row.expires_at < Date.now() || row.challenge !== (await challengeOf(verifier))) {
    return fail("That sign-in didn't work. Try again.");
  }
  const user = await env.DB.prepare("SELECT id, name, avatar, banned FROM users WHERE id = ?").bind(row.user_id).first<User>();
  if (!user || user.banned) return fail("That sign-in didn't work. Try again.");
  const secret = randomToken();
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, kind, label, created_at)
    SELECT ?, id, ?, 'app', ?, ? FROM users WHERE id = ? AND auth_version = ? AND banned = 0`)
    .bind(await hash(secret), now + APP_SESSION_DAYS * 86400_000, row.label, now, user.id, row.auth_version).run();
  if (result.meta.changes !== 1) return fail("That sign-in didn't work. Try again.");
  return json({ token: secret, user: await profile(env, user) });
}

// Uploads

const MAX_PENDING = 5;
const MAX_PER_DAY = 20;

/** Checks and stores an uploaded pack as a version waiting for review, for /submit and the app alike. */
export async function acceptUpload(
  env: Env,
  user: User,
  upload: Uint8Array,
): Promise<{ error: string } | { meta: PackMeta; sha: string; update: boolean }> {
  if (user.banned) return { error: "This account can't submit packs." };
  const now = Date.now();
  const counts = await env.DB.prepare(
    `SELECT SUM(status = 'pending') AS pending, SUM(submitted_at > ?) AS today FROM versions WHERE submitted_by = ?`,
  )
    .bind(now - 86400_000, user.id)
    .first<{ pending: number | null; today: number | null }>();
  if ((counts?.pending ?? 0) >= MAX_PENDING) return { error: `You have ${MAX_PENDING} packs waiting for review. Try again once they're reviewed.` };
  if ((counts?.today ?? 0) >= MAX_PER_DAY) return { error: "That's a lot of uploads for one day. Try again tomorrow." };

  const meta = readPack(upload, user.name);
  if (typeof meta === "string") return { error: meta };
  // Stored and hashed with the uploader's name in front of each block ID.
  const bytes = stampPack(upload, user.name);
  if (typeof bytes === "string") return { error: bytes };
  const sha = await sha256Hex(bytes);

  if (await env.DB.prepare("SELECT 1 FROM versions WHERE sha256 = ?").bind(sha).first()) {
    return { error: "This exact file was already submitted." };
  }
  const pack = await env.DB.prepare("SELECT owner_id, listed FROM packs WHERE id = ?").bind(meta.id).first<{ owner_id: string; listed: number }>();
  if (pack && pack.owner_id !== user.id) {
    return { error: `Another account already shares a pack with the id "${meta.id}". Give yours a different id.` };
  }
  if (pack && !pack.listed) return { error: "This pack was taken down, so it can't be updated." };

  await env.PACKS.put(`packs/${sha}.json`, bytes, { httpMetadata: { contentType: "application/json" } });
  const statements = [
    // A newer upload replaces one still waiting.
    env.DB.prepare(
      "UPDATE versions SET status = 'rejected', reason = 'Replaced by a newer upload', reviewed_at = ? WHERE pack_id = ? AND status = 'pending'",
    ).bind(now, meta.id),
    env.DB.prepare(
      `INSERT INTO versions (pack_id, sha256, name, description, version, blocks, block_views, capabilities, status, submitted_by, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(meta.id, sha, meta.name, meta.description, meta.version, JSON.stringify(meta.blocks), JSON.stringify(meta.views), JSON.stringify(meta.capabilities), user.id, now),
  ];
  if (!pack) {
    statements.unshift(env.DB.prepare("INSERT INTO packs (id, owner_id, created_at) VALUES (?, ?, ?)").bind(meta.id, user.id, now));
  }
  // An update replaces a listed version; until one is approved it's still a first share.
  const listed = pack
    ? await env.DB.prepare("SELECT 1 FROM versions WHERE pack_id = ? AND status = 'approved' LIMIT 1").bind(meta.id).first()
    : null;
  const saved = await env.DB.batch(statements);
  const versionId = saved[saved.length - 1].meta.last_row_id;
  await notify(env, { title: `Pack submission: ${meta.name}`, text: `${user.name} submitted ${meta.name} (${meta.version}) for review.`, url: `${env.SITE_URL}/admin/versions/${versionId}` });
  return { meta, sha, update: !!listed };
}

// Packs and comments

function commentJson(c: Awaited<ReturnType<typeof listComments>>[number], user: User | null, admin: boolean, ownerId: string) {
  return {
    id: c.id,
    author: c.name,
    avatar: c.avatar,
    author_page: c.public_id ? `/authors/${c.public_id}` : "",
    official: c.user_id === OFFICIAL_OWNER,
    pack_author: c.user_id === ownerId,
    mine: !!user && user.id === c.user_id,
    can_delete: canDelete(user, admin, ownerId, c),
    body: c.body,
    created: c.created_at,
  };
}

/** GET /api/v1/packs/<id>: what the pack page shows. */
async function packDetail(env: Env, user: User | null, admin: boolean, id: string): Promise<Response> {
  const p = await listedPack(env, id);
  if (!p) return fail("That pack isn't in the library.", 404);
  const [{ results: versions }, comments] = await Promise.all([
    env.DB.prepare("SELECT version, sha256, submitted_at, reviewed_at FROM versions WHERE pack_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 50")
      .bind(p.pack_id)
      .all<{ version: string; sha256: string; submitted_at: number; reviewed_at: number | null }>(),
    listComments(env, p.pack_id),
  ]);
  return json({
    id: p.pack_id,
    name: p.name,
    description: p.description,
    version: p.version,
    sha256: p.sha256,
    author: p.author,
    author_page: p.author_public_id ? `/authors/${p.author_public_id}` : "",
    official: p.owner_id === OFFICIAL_OWNER,
    mine: !!user && user.id === p.owner_id,
    page: `/packs/${encodeURIComponent(p.pack_id)}`,
    updated: p.submitted_at,
    created: p.pack_created_at,
    capabilities: JSON.parse(p.capabilities),
    versions: versions.map((v) => ({
      version: v.version,
      sha256: v.sha256,
      url: `packs/${v.sha256}.json`,
      date: v.reviewed_at ?? v.submitted_at,
    })),
    comments: comments.map((c) => commentJson(c, user, admin, p.owner_id)),
    can_comment: !!user && !user.banned,
  });
}

/** GET /api/v1/me: the account and every pack it has submitted, newest upload first. */
async function me(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.pack_id, v.sha256, v.name, v.description, v.version, v.blocks, v.block_views, v.status, v.reason,
            v.submitted_at, v.reviewed_at, p.listed
     FROM versions v JOIN packs p ON p.id = v.pack_id WHERE p.owner_id = ? ORDER BY v.id DESC LIMIT 300`,
  )
    .bind(user.id)
    .all<{
      id: number;
      pack_id: string;
      sha256: string;
      name: string;
      description: string;
      version: string;
      blocks: string;
      block_views: string;
      status: string;
      reason: string;
      submitted_at: number;
      reviewed_at: number | null;
      listed: number;
    }>();
  await withBlockViews(env, results);
  const packs = new Map<string, { id: string; name: string; description: string; listed: boolean; live: string; page: string; versions: unknown[] }>();
  for (const v of results) {
    let pack = packs.get(v.pack_id);
    if (!pack) {
      pack = { id: v.pack_id, name: v.name, description: v.description, listed: !!v.listed, live: "", page: `/packs/${encodeURIComponent(v.pack_id)}`, versions: [] };
      packs.set(v.pack_id, pack);
    }
    if (!pack.live && v.status === "approved") pack.live = v.version || v.sha256.slice(0, 8);
    pack.versions.push({
      version: v.version,
      sha256: v.sha256,
      status: v.status,
      reason: v.reason,
      blocks: JSON.parse(v.blocks),
      submitted: v.submitted_at,
      reviewed: v.reviewed_at,
    });
  }
  return json({ user: await profile(env, user), packs: [...packs.values()] });
}

/** POST /api/v1/packs: the body is a pack file, the same one /submit takes. */
async function upload(req: Request, env: Env, user: User): Promise<Response> {
  const length = Number(req.headers.get("Content-Length") ?? 0);
  if (length > 4 * 1024 * 1024) return fail("That file is over 2 MB.", 413);
  const result = await acceptUpload(env, user, new Uint8Array(await req.arrayBuffer()));
  if ("error" in result) return fail(result.error);
  return json({ id: result.meta.id, name: result.meta.name, version: result.meta.version, sha256: result.sha, status: "pending", update: result.update });
}

/** Everything under /api/v1/. Never reads the cookie, so other sites can't use it. */
export async function api(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;
  if (method === "POST" && path === "/api/v1/app/token") return token(req, env);
  const user = await bearerUser(req, env);
  const admin = isAdmin(env, user);
  let m: RegExpMatchArray | null;
  if (method === "GET" && (m = path.match(/^\/api\/v1\/packs\/([^/]{1,400})$/))) {
    let id = "";
    try {
      id = decodeURIComponent(m[1]);
    } catch {}
    return packDetail(env, user, admin, id);
  }
  if (!user) return fail("Sign in to Blockwork's community library first.", 401);
  if (method === "GET" && path === "/api/v1/me") return me(env, user);
  if (method === "POST" && path === "/api/v1/app/logout") {
    const auth = (req.headers.get("Authorization") ?? "").slice("Bearer ".length);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? AND kind = 'app'").bind(await hash(auth)).run();
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/v1/packs") return upload(req, env, user);
  if (method === "POST" && (m = path.match(/^\/api\/v1\/packs\/([^/]{1,400})\/comments$/))) {
    let id = "";
    try {
      id = decodeURIComponent(m[1]);
    } catch {}
    const { body: text } = await body(req);
    const result = await addComment(env, user, admin, id, typeof text === "string" ? text : "");
    if ("error" in result) return fail(result.error, result.status);
    const p = await listedPack(env, id);
    const added = (await listComments(env, id)).find((c) => c.id === result.id);
    return added && p ? json(commentJson(added, user, admin, p.owner_id)) : json({ id: result.id });
  }
  if (method === "DELETE" && (m = path.match(/^\/api\/v1\/comments\/(\d+)$/))) {
    const result = await removeComment(env, user, admin, Number(m[1]));
    return result ? json({ ok: true }) : fail("That comment doesn't exist.", 404);
  }
  return fail("Not found", 404);
}

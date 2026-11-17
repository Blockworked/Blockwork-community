// Admin pages: the review queue, one upload's review, and taking packs down
// or banning accounts. Routed from index.ts for ADMINS only.

import type { User } from "./auth.ts";
import { capabilityList, esc, message, page } from "./pages.ts";
import { packCard, sourceView, withBlockViews, type VersionRow } from "./browse.ts";
import { blockPictures, redraw } from "./renders.ts";
import type { Env } from "./index.ts";
import { note, record, type Change } from "./moderation.ts";
import { MOD_CSS } from "./moderation-admin.ts";

export async function reviewQueue(env: Env, user: User, admin: boolean): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT v.*, u.name AS author, u.shadowbanned AS shadowbanned, u.created_at AS user_created FROM versions v JOIN users u ON u.id = v.submitted_by
     WHERE v.status = 'pending' ORDER BY v.submitted_at`,
  ).all<VersionRow & { shadowbanned: number; user_created: number }>();
  await withBlockViews(env, results);
  const card = (v: VersionRow & { user_created: number }) =>
    packCard(
      v,
      `<p class="mod-actions"><label><input type="checkbox" name="v" value="${v.id}" form="bulk"> Select</label>
       <a class="button primary" href="/admin/versions/${v.id}">Review</a>
       <a href="/admin/users/${encodeURIComponent(v.submitted_by)}">${esc(v.author)}</a>${v.user_created > Date.now() - 3 * 86400_000 ? ` <span class="muted">new account</span>` : ""}</p>`,
    );
  const list = results.filter((v) => !v.shadowbanned).map(card).join("");
  const hidden = results.filter((v) => v.shadowbanned).map(card).join("");
  return page(
    "Review",
    user,
    admin,
    `${MOD_CSS}<p class="crumbs"><a href="/admin/moderation">Moderation</a> · <a href="/admin/moderation/log">Moderation log</a></p>
     <h1>Waiting for review</h1>${list || `<p class="muted">Nothing to review.</p>`}
     ${hidden ? `<h2>From shadowbanned accounts</h2><p class="muted">They think these are waiting like any other.</p>${hidden}` : ""}
     ${results.length ? `<form id="bulk" method="post" action="/admin/versions" class="mod-actions"><input type="text" name="reason" placeholder="Reason (shown to the submitter)" maxlength="300">
       <button>Reject selected</button></form>` : ""}
     <p class="muted"><a href="/admin/renders">Draw block pictures</a> for versions that don't have them yet.</p>`,
  );
}

export async function reviewPage(env: Env, user: User, admin: boolean, id: number, params: URLSearchParams): Promise<Response> {
  const v = await env.DB.prepare(
    `SELECT v.*, u.name AS author, u.banned AS banned, p.listed AS listed FROM versions v
     JOIN users u ON u.id = v.submitted_by JOIN packs p ON p.id = v.pack_id WHERE v.id = ?`,
  )
    .bind(id)
    .first<VersionRow & { banned: number; listed: number }>();
  if (!v) return message(user, admin, "Not found", "That submission doesn't exist.", 404);
  await withBlockViews(env, [v]);
  const object = await env.PACKS.get(`packs/${v.sha256}.json`);
  const base = `/admin/versions/${v.id}`;
  const source = sourceView(
    env,
    object ? await object.text() : null,
    params.get("view") === "json" ? "json" : "blocks",
    // Opening it also draws the pictures the lists show, once.
    { blocks: `${base}#file`, json: `${base}?view=json#file`, file: `${base}/file`, render: v.renders ? "" : `${base}/renders` },
    `${v.name} in Blockwork's editor`,
  );
  const previous = await env.DB.prepare(
    "SELECT version, sha256 FROM versions WHERE pack_id = ? AND status = 'approved' AND id < ? ORDER BY id DESC LIMIT 1",
  )
    .bind(v.pack_id, v.id)
    .first<{ version: string; sha256: string }>();
  const decide =
    v.status === "pending"
      ? `<form method="post"><p><input type="text" name="reason" placeholder="Reason (shown to the submitter if rejected)" maxlength="300"></p>
         <p><button class="primary" name="action" value="approve">Approve</button> <button name="action" value="reject">Reject</button></p></form>`
      : `<p><strong>${esc(v.status)}</strong>${v.reason ? `: ${esc(v.reason)}` : ""}</p>`;
  return page(
    `Review ${v.name}`,
    user,
    admin,
    `<h1>${esc(v.name)} <span class="version">${esc(v.version)}</span></h1>
     <p class="muted meta"><span>id ${esc(v.pack_id)}</span><span>by ${esc(v.author)} (${esc(v.submitted_by)})</span><span>sha256 <span class="mono">${esc(v.sha256)}</span></span></p>
     <p>${previous ? `Updates the listed version ${esc(previous.version || previous.sha256.slice(0, 12))}.` : "A new pack."}</p>
     <p>${esc(v.description)}</p>${blockPictures(v)}
     <h2>What it can do</h2>${capabilityList(JSON.parse(v.capabilities))}
     <h2>Decision</h2>${decide}
     <h2 id="file">File</h2>${source}
     <h2>Moderation</h2>
     <form class="inline" method="post" action="/admin/versions/${v.id}/redraw"><button>Redraw block pictures</button></form>
     <form class="inline" method="post" action="/admin/packs/${encodeURIComponent(v.pack_id)}">
       <button name="action" value="${v.listed ? "unlist" : "list"}">${v.listed ? "Take the pack down" : "List the pack again"}</button></form>
     <form class="inline" method="post" action="/admin/users/${encodeURIComponent(v.submitted_by)}">
       <button name="action" value="${v.banned ? "unban" : "ban"}">${v.banned ? "Unban the submitter" : "Ban the submitter"}</button></form>`,
  );
}

export async function reviewFile(env: Env, id: number): Promise<Response> {
  const v = await env.DB.prepare("SELECT sha256 FROM versions WHERE id = ?").bind(id).first<{ sha256: string }>();
  const object = v ? await env.PACKS.get(`packs/${v.sha256}.json`) : null;
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: { "Content-Type": "application/json" } });
}

export async function reviewDecision(req: Request, env: Env, id: number, actor: User): Promise<Response> {
  const form = await req.formData();
  const action = form.get("action");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 300);
  if (action !== "approve" && action !== "reject") return new Response("Bad request", { status: 400 });
  const result = await env.DB.prepare("UPDATE versions SET status = ?, reason = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'")
    .bind(action === "approve" ? "approved" : "rejected", action === "approve" ? "" : reason, Date.now(), id)
    .run();
  if (result.meta.changes) await note(env, actor.id, action, { kind: "version", id }, reason);
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

export async function setListed(req: Request, env: Env, packId: string, actor: User): Promise<Response> {
  const action = (await req.formData()).get("action");
  const pack = await env.DB.prepare("SELECT listed FROM packs WHERE id = ?").bind(packId).first<{ listed: number }>();
  if (pack) await record(env, actor.id, action === "list" ? "list-pack" : "unlist-pack", { kind: "pack", id: packId }, "", [{ kind: "pack", id: packId, before: { listed: pack.listed }, after: { listed: action === "list" ? 1 : 0 } }]);
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

/** Rejects a set of uploads at once, from the review queue. Logged, so it can be undone. */
export async function bulkVersions(req: Request, env: Env, actor: User): Promise<Response> {
  const form = await req.formData();
  const ids = form.getAll("v").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT id, reason, reviewed_at FROM versions WHERE status = 'pending' AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: number; reason: string; reviewed_at: number | null }>();
    const reason = String(form.get("reason") ?? "").trim().slice(0, 300) || "Removed by moderation";
    await record(env, actor.id, "reject-uploads", { kind: "versions", id: ids.join(",").slice(0, 200) }, reason, results.map((v): Change => ({
      kind: "version", id: v.id, before: { status: "pending", reason: v.reason, reviewed_at: v.reviewed_at }, after: { status: "rejected", reason, reviewed_at: Date.now() },
    })));
  }
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

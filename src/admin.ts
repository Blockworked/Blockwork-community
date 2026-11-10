// Admin pages: the review queue, one upload's review, and taking packs down
// or banning accounts. Routed from index.ts for ADMINS only.

import type { User } from "./auth.ts";
import { capabilityList, esc, message, page } from "./pages.ts";
import { packCard, sourceView, withBlockViews, type VersionRow } from "./browse.ts";
import { blockPictures, redraw } from "./renders.ts";
import type { Env } from "./index.ts";

export async function reviewQueue(env: Env, user: User, admin: boolean): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT v.*, u.name AS author FROM versions v JOIN users u ON u.id = v.submitted_by
     WHERE v.status = 'pending' ORDER BY v.submitted_at`,
  ).all<VersionRow>();
  await withBlockViews(env, results);
  const list = results.map((v) => packCard(v, `<p><a class="button primary" href="/admin/versions/${v.id}">Review</a></p>`)).join("");
  return page(
    "Review",
    user,
    admin,
    `<h1>Waiting for review</h1>${list || `<p class="muted">Nothing to review.</p>`}
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

export async function reviewDecision(req: Request, env: Env, id: number): Promise<Response> {
  const form = await req.formData();
  const action = form.get("action");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 300);
  if (action !== "approve" && action !== "reject") return new Response("Bad request", { status: 400 });
  await env.DB.prepare("UPDATE versions SET status = ?, reason = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'")
    .bind(action === "approve" ? "approved" : "rejected", action === "approve" ? "" : reason, Date.now(), id)
    .run();
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

export async function setListed(req: Request, env: Env, packId: string): Promise<Response> {
  const action = (await req.formData()).get("action");
  await env.DB.prepare("UPDATE packs SET listed = ? WHERE id = ?").bind(action === "list" ? 1 : 0, packId).run();
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

export async function setBanned(req: Request, env: Env, userId: string): Promise<Response> {
  const ban = (await req.formData()).get("action") === "ban";
  const statements = [env.DB.prepare("UPDATE users SET banned = ? WHERE id = ? AND deleted_at = 0").bind(ban ? 1 : 0, userId)];
  if (ban) {
    statements.push(
      env.DB.prepare("UPDATE versions SET status = 'rejected', reason = 'Account banned', reviewed_at = ? WHERE submitted_by = ? AND status = 'pending'").bind(
        Date.now(),
        userId,
      ),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    );
  }
  await env.DB.batch(statements);
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}

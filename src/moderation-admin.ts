// Admin moderation pages: held comments, reports, recent activity with bulk
// actions, one account's everything with rollback, lockdown, the blocklist and
// the log of every action with undo. Routed from index.ts for ADMINS only.

import type { User } from "./auth.ts";
import type { Env } from "./index.ts";
import { esc, page } from "./pages.ts";
import { commentHtml } from "./comments.ts";
import {
  FLOOD_PER_HOUR,
  lockdown,
  NEW_ACCOUNT_MS,
  networksOf,
  note,
  record,
  rollbackAccount,
  sameNetwork,
  setting,
  turnstileOn,
  undo,
  type BanMode,
  type Change,
} from "./moderation.ts";

export const MOD_CSS = `<style>
.mod-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin: 12px 0 24px; }
.mod-stat { padding: 12px 14px; border: 1px solid var(--glass-border); border-radius: var(--radius-lg); background: var(--glass); }
.mod-stat strong { display: block; font-size: 24px; }
.mod-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--glass-border); border-radius: var(--radius-lg); overflow: hidden; }
.mod-list li { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-top: 1px solid var(--glass-border); }
.mod-list li:first-child { border-top: 0; }
.mod-list .body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mod-list .body p { margin: 2px 0; }
.mod-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 0; }
.mod-actions select, .mod-actions input[type=text] { padding: 6px 8px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg2); color: var(--fg); font: inherit; }
.pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.pill.bad { color: var(--warn); border-color: var(--warn-border); }
table.mod { width: 100%; border-collapse: collapse; font-size: 14px; }
table.mod th, table.mod td { text-align: left; padding: 6px 8px; border-top: 1px solid var(--glass-border); vertical-align: top; }
</style>`;

const SPANS: Record<string, number> = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000, all: 0 };

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: { Location: to } });
}

function userLink(id: string, name: string): string {
  return `<a href="/admin/users/${encodeURIComponent(id)}">${esc(name)}</a>`;
}

function flags(u: { banned?: number; shadowbanned?: number; created_at?: number }): string {
  const out: string[] = [];
  if (u.banned) out.push(`<span class="pill bad">banned</span>`);
  if (u.shadowbanned) out.push(`<span class="pill bad">shadowbanned</span>`);
  if (u.created_at && u.created_at > Date.now() - NEW_ACCOUNT_MS) out.push(`<span class="pill">new</span>`);
  return out.join(" ");
}

const ROLLBACK_FIELDS = `<select name="since" aria-label="Since"><option value="1h">Last hour</option><option value="24h" selected>Last 24 hours</option><option value="7d">Last 7 days</option><option value="all">Everything</option></select>
  <select name="ban" aria-label="Then"><option value="ban">and ban</option><option value="shadow">and shadowban</option><option value="none">without banning</option></select>
  <label><input type="checkbox" name="network" value="1"> block their networks</label>`;

interface Activity {
  id: number;
  pack_id: string;
  user_id: string;
  body: string;
  created_at: number;
  held: number;
  removed_at: number | null;
  name: string;
  banned: number;
  shadowbanned: number;
  user_created: number;
  reports?: number;
}

function commentRows(rows: Activity[], showReports = false): string {
  if (!rows.length) return `<p class="muted">None.</p>`;
  return `<ul class="mod-list">${rows
    .map(
      (c) => `<li><input type="checkbox" name="c" value="${c.id}" aria-label="Select comment ${c.id}">
      <div class="body"><p class="meta muted">${userLink(c.user_id, c.name)} ${flags({ banned: c.banned, shadowbanned: c.shadowbanned, created_at: c.user_created })}
        on <a href="/packs/${encodeURIComponent(c.pack_id)}#comment-${c.id}">${esc(c.pack_id)}</a> · ${esc(when(c.created_at))}
        ${c.held ? `<span class="pill">held</span>` : ""}${c.removed_at ? `<span class="pill bad">removed</span>` : ""}${showReports && c.reports ? ` <span class="pill bad">${c.reports} reports</span>` : ""}</p>
      <p>${commentHtml(c.body.slice(0, 600))}</p></div></li>`,
    )
    .join("")}</ul>`;
}

const COMMENT_SELECT = `SELECT c.id, c.pack_id, c.user_id, c.body, c.created_at, c.held, c.removed_at, u.name, u.banned, u.shadowbanned, u.created_at AS user_created
  FROM comments c JOIN users u ON u.id = c.user_id`;

export async function moderationPage(env: Env, user: User, notice = ""): Promise<Response> {
  const now = Date.now();
  const [held, reported, recent, accounts, stats, reports, blocks, mode, signups] = await Promise.all([
    env.DB.prepare(`${COMMENT_SELECT} WHERE c.held = 1 AND c.removed_at IS NULL AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 200`).all<Activity>(),
    env.DB.prepare(
      `${COMMENT_SELECT.replace("SELECT c.id", "SELECT (SELECT COUNT(*) FROM reports r WHERE r.kind = 'comment' AND r.item_id = CAST(c.id AS TEXT) AND r.resolved_at IS NULL) AS reports, c.id")}
       WHERE c.removed_at IS NULL AND c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM reports r WHERE r.kind = 'comment' AND r.item_id = CAST(c.id AS TEXT) AND r.resolved_at IS NULL)
       ORDER BY c.created_at DESC LIMIT 200`,
    ).all<Activity>(),
    env.DB.prepare(`${COMMENT_SELECT} WHERE c.deleted_at IS NULL AND c.created_at > ? ORDER BY c.created_at DESC LIMIT 150`).bind(now - 3 * 86400_000).all<Activity>(),
    env.DB.prepare(
      `SELECT u.id, u.name, u.created_at, u.banned, u.shadowbanned,
         (SELECT COUNT(*) FROM comments WHERE user_id = u.id) AS comments,
         (SELECT COUNT(*) FROM versions WHERE submitted_by = u.id) AS uploads,
         (SELECT COUNT(*) FROM tickets WHERE user_id = u.id) AS tickets
       FROM users u WHERE u.created_at > ? AND u.deleted_at = 0 ORDER BY u.created_at DESC LIMIT 100`,
    )
      .bind(now - 2 * 86400_000)
      .all<{ id: string; name: string; created_at: number; banned: number; shadowbanned: number; comments: number; uploads: number; tickets: number }>(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM comments WHERE created_at > ?1) AS comments, (SELECT COUNT(*) FROM users WHERE created_at > ?1) AS signups,
         (SELECT COUNT(*) FROM versions WHERE submitted_at > ?1) AS uploads, (SELECT COUNT(*) FROM tickets WHERE created_at > ?1) AS tickets,
         (SELECT COUNT(*) FROM comments c JOIN users u ON u.id = c.user_id WHERE c.created_at > ?1 AND u.created_at > ?2) AS fresh`,
    )
      .bind(now - 3600_000, now - NEW_ACCOUNT_MS)
      .first<{ comments: number; signups: number; uploads: number; tickets: number; fresh: number }>(),
    env.DB.prepare(
      `SELECT r.id, r.kind, r.item_id, r.reason, r.created_at, u.name AS reporter, u.id AS reporter_id FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
       WHERE r.resolved_at IS NULL AND r.kind = 'pack' ORDER BY r.created_at DESC LIMIT 100`,
    ).all<{ id: number; kind: string; item_id: string; reason: string; created_at: number; reporter: string | null; reporter_id: string | null }>(),
    env.DB.prepare("SELECT * FROM blocklist WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 200").bind(now).all<{
      id: number;
      kind: string;
      value: string;
      reason: string;
      created_at: number;
    }>(),
    lockdown(env),
    setting(env, "signups", "open"),
  ]);
  const s = stats!;
  const lockForm = `<form method="post" action="/admin/moderation/settings" class="mod-actions">
    <label>Posting <select name="lockdown">
      <option value="off"${mode === "off" ? " selected" : ""}>open to everyone</option>
      <option value="new"${mode === "new" ? " selected" : ""}>paused for new accounts</option>
      <option value="all"${mode === "all" ? " selected" : ""}>paused for everyone but admins</option></select></label>
    <label>Sign-ups <select name="signups"><option value="open"${signups !== "closed" ? " selected" : ""}>open</option><option value="closed"${signups === "closed" ? " selected" : ""}>closed</option></select></label>
    <button class="primary">Save</button></form>`;
  const accountRows = accounts.results.length
    ? `<table class="mod"><thead><tr><th></th><th>Account</th><th>Joined</th><th>Comments</th><th>Uploads</th><th>Tickets</th></tr></thead><tbody>${accounts.results
        .map(
          (a) => `<tr><td><input type="checkbox" name="u" value="${esc(a.id)}" aria-label="Select ${esc(a.name)}"></td><td>${userLink(a.id, a.name)} ${flags(a)}</td><td>${esc(when(a.created_at))}</td>
          <td>${a.comments}</td><td>${a.uploads}</td><td>${a.tickets}</td></tr>`,
        )
        .join("")}</tbody></table>
      <div class="mod-actions"><button name="action" value="rollback">Roll back selected</button> ${ROLLBACK_FIELDS}</div>`
    : `<p class="muted">No new accounts in the last two days.</p>`;
  const packReports = reports.results.length
    ? `<ul class="mod-list">${reports.results
        .map(
          (r) => `<li><div class="body"><p><a href="/packs/${encodeURIComponent(r.item_id)}">${esc(r.item_id)}</a>: ${esc(r.reason)}</p>
          <p class="muted">by ${r.reporter_id ? userLink(r.reporter_id, r.reporter ?? r.reporter_id) : "a deleted account"} · ${esc(when(r.created_at))}</p>
          <form class="mod-actions" method="post" action="/admin/reports/${r.id}"><button name="action" value="dismiss">Dismiss</button><button name="action" value="unlist">Take the pack down</button></form></div></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">None.</p>`;
  const blockRows = blocks.results.length
    ? `<table class="mod"><thead><tr><th>Kind</th><th>Value</th><th>Reason</th><th>Added</th><th></th></tr></thead><tbody>${blocks.results
        .map(
          (b) => `<tr><td>${esc(b.kind)}</td><td class="mono">${esc(b.kind === "ip" ? `${b.value.slice(0, 12)}…` : b.value)}</td><td>${esc(b.reason)}</td><td>${esc(when(b.created_at))}</td>
          <td><form class="inline" method="post" action="/admin/moderation/blocklist"><input type="hidden" name="remove" value="${b.id}"><button class="ghost small">Remove</button></form></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing blocked.</p>`;
  const bulk = (rows: string, extra = "") => rows.includes("<li>") ? `<form method="post" action="/admin/moderation/comments">${rows}
    <div class="mod-actions">${extra}<button name="action" value="remove">Remove selected</button><button name="action" value="rollback">Remove and roll back their writers</button> ${ROLLBACK_FIELDS}</div></form>` : rows;
  return page(
    "Moderation",
    user,
    true,
    `${MOD_CSS}<p class="crumbs"><a href="/admin">Review queue</a> · <a href="/admin/moderation/log">Moderation log</a></p>
     <h1>Moderation</h1>${notice ? `<p class="risky">${esc(notice)}</p>` : ""}
     <div class="mod-grid">
       <div class="mod-stat"><strong>${s.comments}</strong> comments in the last hour<br><span class="muted">${s.fresh} from new accounts (holds at ${FLOOD_PER_HOUR})</span></div>
       <div class="mod-stat"><strong>${s.signups}</strong> new accounts in the last hour</div>
       <div class="mod-stat"><strong>${s.uploads}</strong> uploads, <strong style="display:inline">${s.tickets}</strong> tickets in the last hour</div>
       <div class="mod-stat"><strong>${turnstileOn(env) ? "On" : "Off"}</strong> Turnstile<br><span class="muted">${turnstileOn(env) ? "on sign-up, tickets, uploads and new accounts' comments" : "set TURNSTILE_SITE_KEY and TURNSTILE_SECRET"}</span></div>
     </div>
     <h2>Emergency switches</h2><p class="muted">Pause posting while you clean up a flood. Admins can always post.</p>${lockForm}
     <h2 id="held">Held comments</h2><p class="muted">New accounts' comments with links, every new account's during a flood, and comments reported by ${3} people wait here. Only their writers see them.</p>
     ${bulk(commentRows(held.results), `<button class="primary" name="action" value="approve">Approve selected</button>`)}
     <h2 id="reports">Reported comments</h2>${bulk(commentRows(reported.results, true), `<button name="action" value="dismiss">Dismiss reports on selected</button>`)}
     <h2>Reported packs</h2>${packReports}
     <h2 id="recent">Recent comments</h2><p class="muted">The last three days.</p>${bulk(commentRows(recent.results))}
     <h2 id="accounts">New accounts</h2><form method="post" action="/admin/moderation/accounts">${accountRows}</form>
     <h2 id="blocklist">Blocklist</h2><p class="muted">Blocked networks can't post; blocked addresses and domains can't email support@ or sign up. Rolling back an account can block its networks.</p>
     <form class="mod-actions" method="post" action="/admin/moderation/blocklist"><select name="kind" aria-label="Kind"><option value="email">Email address</option><option value="domain">Email domain</option></select>
       <input type="text" name="value" placeholder="spam@example.com or example.com" maxlength="254" required><input type="text" name="reason" placeholder="Reason" maxlength="200"><button>Block</button></form>
     ${blockRows}`,
  );
}

function since(form: FormData): number {
  const span = SPANS[String(form.get("since") ?? "24h")] ?? SPANS["24h"];
  return span ? Date.now() - span : 0;
}

function banMode(form: FormData): BanMode {
  const b = String(form.get("ban") ?? "ban");
  return b === "shadow" || b === "none" ? b : "ban";
}

/** Approve, remove or roll back a set of comments. */
export async function bulkComments(req: Request, env: Env, actor: User): Promise<Response> {
  const form = await req.formData();
  const ids = form.getAll("c").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const action = String(form.get("action") ?? "");
  if (!ids.length) return moderationPage(env, actor, "Select something first.");
  const marks = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT id, user_id, held, removed_at FROM comments WHERE id IN (${marks})`)
    .bind(...ids)
    .all<{ id: number; user_id: string; held: number; removed_at: number | null }>();
  const now = Date.now();
  if (action === "approve") {
    await env.DB.batch([
      env.DB.prepare(`UPDATE comments SET held = 0 WHERE id IN (${marks})`).bind(...ids),
      env.DB.prepare(`UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE kind = 'comment' AND resolved_at IS NULL AND item_id IN (${marks})`).bind(now, actor.id, ...ids.map(String)),
    ]);
    await note(env, actor.id, "approve-comments", { kind: "comments", id: ids.join(",").slice(0, 200) }, `${ids.length} comments`);
    return redirect("/admin/moderation#held");
  }
  if (action === "dismiss") {
    await env.DB.prepare(`UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE kind = 'comment' AND resolved_at IS NULL AND item_id IN (${marks})`)
      .bind(now, actor.id, ...ids.map(String))
      .run();
    await note(env, actor.id, "dismiss-reports", { kind: "comments", id: ids.join(",").slice(0, 200) });
    return redirect("/admin/moderation#reports");
  }
  if (action === "remove") {
    const changes: Change[] = results
      .filter((c) => !c.removed_at)
      .map((c) => ({ kind: "comment", id: c.id, before: { removed_at: null, held: c.held }, after: { removed_at: now, held: 0 } }));
    changes.push(...(await reportChanges(env, ids.map(String), actor.id)));
    await record(env, actor.id, "remove-comments", { kind: "comments", id: ids.join(",").slice(0, 200) }, `${changes.length} changes`, changes);
    return redirect("/admin/moderation");
  }
  if (action === "rollback") {
    const writers = [...new Set(results.map((c) => c.user_id))];
    const done = await rollbackMany(env, actor, writers, since(form), banMode(form), form.get("network") === "1");
    return moderationPage(env, actor, done);
  }
  return new Response("Bad request", { status: 400 });
}

async function reportChanges(env: Env, itemIds: string[], actor: string): Promise<Change[]> {
  if (!itemIds.length) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM reports WHERE kind = 'comment' AND resolved_at IS NULL AND item_id IN (${itemIds.map(() => "?").join(",")})`)
    .bind(...itemIds)
    .all<{ id: number }>();
  return results.map((r) => ({ kind: "report", id: r.id, before: { resolved_at: null, resolved_by: null }, after: { resolved_at: Date.now(), resolved_by: actor } }));
}

async function rollbackMany(env: Env, actor: User, userIds: string[], from: number, ban: BanMode, network: boolean): Promise<string> {
  const totals: Record<string, number> = {};
  let accounts = 0;
  for (const id of userIds.slice(0, 100)) {
    if (id === actor.id) continue;
    const done = await rollbackAccount(env, actor.id, id, from, ban, network);
    if (!done) continue;
    accounts++;
    for (const [k, n] of Object.entries(done.counts)) totals[k] = (totals[k] ?? 0) + n;
  }
  const parts = Object.entries(totals)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`);
  return `Rolled back ${accounts} account${accounts === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}. Undo from the moderation log.`;
}

export async function bulkAccounts(req: Request, env: Env, actor: User): Promise<Response> {
  const form = await req.formData();
  const ids = form.getAll("u").map(String).filter(Boolean);
  if (!ids.length) return moderationPage(env, actor, "Select something first.");
  return moderationPage(env, actor, await rollbackMany(env, actor, ids, since(form), banMode(form), form.get("network") === "1"));
}

export async function settingsAction(req: Request, env: Env, actor: User): Promise<Response> {
  const form = await req.formData();
  const mode = String(form.get("lockdown") ?? "off");
  const signups = String(form.get("signups") ?? "open");
  if (!["off", "new", "all"].includes(mode) || !["open", "closed"].includes(signups)) return new Response("Bad request", { status: 400 });
  const now = Date.now();
  await env.DB.batch(
    [
      ["lockdown", mode],
      ["signups", signups],
    ].map(([k, v]) =>
      env.DB.prepare(
        "INSERT INTO moderation_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      ).bind(k, v, actor.id, now),
    ),
  );
  await note(env, actor.id, "settings", { kind: "site", id: "settings" }, `posting ${mode}; sign-ups ${signups}`);
  return redirect("/admin/moderation");
}

export async function blocklistAction(req: Request, env: Env, actor: User): Promise<Response> {
  const form = await req.formData();
  const remove = Number(form.get("remove") ?? 0);
  if (remove) {
    const row = await env.DB.prepare("DELETE FROM blocklist WHERE id = ? RETURNING kind, value").bind(remove).first<{ kind: string; value: string }>();
    if (row) await note(env, actor.id, "unblock", { kind: row.kind, id: row.kind === "ip" ? row.value.slice(0, 12) : row.value });
    return redirect("/admin/moderation#blocklist");
  }
  const kind = String(form.get("kind") ?? "");
  const value = String(form.get("value") ?? "").trim().toLowerCase().replace(/^@/, "");
  const valid = kind === "email" ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) : kind === "domain" ? /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) : false;
  if (!valid || value.length > 254) return moderationPage(env, actor, "That isn't an email address or domain.");
  await record(env, actor.id, "block", { kind, id: value }, String(form.get("reason") ?? ""), [
    { kind: "block", id: value, before: {}, after: { kind, value, reason: String(form.get("reason") ?? "") } },
  ]);
  return redirect("/admin/moderation#blocklist");
}

export async function reportAction(req: Request, env: Env, actor: User, id: number): Promise<Response> {
  const action = String((await req.formData()).get("action") ?? "");
  const r = await env.DB.prepare("SELECT * FROM reports WHERE id = ? AND resolved_at IS NULL").bind(id).first<{ id: number; kind: string; item_id: string }>();
  if (!r) return redirect("/admin/moderation#reports");
  const resolve: Change = { kind: "report", id: r.id, before: { resolved_at: null, resolved_by: null }, after: { resolved_at: Date.now(), resolved_by: actor.id } };
  if (action === "unlist" && r.kind === "pack") {
    const others = await env.DB.prepare("SELECT id FROM reports WHERE kind = 'pack' AND item_id = ? AND resolved_at IS NULL AND id != ?").bind(r.item_id, r.id).all<{ id: number }>();
    await record(env, actor.id, "unlist-pack", { kind: "pack", id: r.item_id }, "from a report", [
      { kind: "pack", id: r.item_id, before: { listed: 1 }, after: { listed: 0 } },
      resolve,
      ...others.results.map((o): Change => ({ ...resolve, id: o.id })),
    ]);
  } else {
    await record(env, actor.id, "dismiss-report", { kind: r.kind, id: r.item_id }, "", [resolve]);
  }
  return redirect("/admin/moderation#reports");
}

// One account

export async function userPage(env: Env, viewer: User, id: string, notice = ""): Promise<Response> {
  const u = await env.DB.prepare("SELECT id, name, created_at, banned, shadowbanned, deleted_at, username, public_id FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; created_at: number; banned: number; shadowbanned: number; deleted_at: number; username: string | null; public_id: string | null }>();
  if (!u) return page("Not found", viewer, true, `<h1>Not found</h1><p>No account ${esc(id)}.</p>`, 404);
  const [comments, versions, tickets, languages, log, network, nets] = await Promise.all([
    env.DB.prepare(`${COMMENT_SELECT} WHERE c.user_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 100`).bind(id).all<Activity>(),
    env.DB.prepare("SELECT id, pack_id, name, version, status, submitted_at FROM versions WHERE submitted_by = ? ORDER BY submitted_at DESC LIMIT 100")
      .bind(id)
      .all<{ id: number; pack_id: string; name: string; version: string; status: string; submitted_at: number }>(),
    env.DB.prepare("SELECT id, subject, status, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(id).all<{ id: number; subject: string; status: string; created_at: number }>(),
    env.DB.prepare("SELECT id, code, name, status, created_at FROM language_proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(id)
      .all<{ id: number; code: string; name: string; status: string; created_at: number }>(),
    env.DB.prepare("SELECT * FROM moderation_log WHERE target_kind = 'user' AND target_id = ? ORDER BY created_at DESC LIMIT 50").bind(id).all<LogRow>(),
    sameNetwork(env, id),
    networksOf(env, id),
  ]);
  const support = (env.SUPPORT_URL || "https://support.blockworked.com").replace(/\/$/, "");
  const weblateUser = `bw_${(await sha256(id)).slice(0, 32)}`;
  const actions = `<form method="post" class="mod-actions">
      ${u.banned ? `<button name="action" value="unban">Unban</button>` : `<button name="action" value="ban">Ban</button>`}
      ${u.shadowbanned ? `<button name="action" value="unshadow">Lift shadowban</button>` : `<button name="action" value="shadow">Shadowban</button>`}</form>
    <form method="post" class="mod-actions"><button class="primary" name="action" value="rollback">Roll back</button> ${ROLLBACK_FIELDS}
      <input type="text" name="reason" placeholder="Reason (for the log)" maxlength="200"></form>
    ${network.length ? `<form method="post" class="mod-actions"><input type="hidden" name="everyone" value="1"><button name="action" value="rollback">Roll back this account and all ${network.length} on its networks</button> ${ROLLBACK_FIELDS}</form>` : ""}`;
  const list = <T>(rows: T[], row: (r: T) => string) => (rows.length ? `<ul class="mod-list">${rows.map((r) => `<li><div class="body">${row(r)}</div></li>`).join("")}</ul>` : `<p class="muted">None.</p>`);
  return page(
    `Moderate ${u.name}`,
    viewer,
    true,
    `${MOD_CSS}<p class="crumbs"><a href="/admin/moderation">Moderation</a> · <a href="/admin/moderation/log">Log</a></p>
     <h1>${esc(u.name)} ${flags(u)}</h1>${notice ? `<p class="risky">${esc(notice)}</p>` : ""}
     <p class="muted meta"><span class="mono">${esc(u.id)}</span><span>joined ${esc(when(u.created_at))}</span>
       ${u.username || u.public_id ? `<a href="/authors/${encodeURIComponent((u.username || u.public_id)!)}">profile</a>` : ""}
       ${env.WEBLATE_URL ? `<a href="${esc(env.WEBLATE_URL.replace(/\/$/, ""))}/user/${weblateUser}/" rel="noreferrer">translations on Weblate (${weblateUser})</a>` : ""}
       <span>${nets.length} network${nets.length === 1 ? "" : "s"}</span></p>
     <p class="muted">Rolling back removes comments, rejects uploads (a listed pack goes back to its previous version), takes down packs started in that time, marks tickets spam and declines language requests. Undo it from the log. Translations live on Weblate: see docs/moderation.md.</p>
     ${u.deleted_at ? `<p class="muted">This account was deleted.</p>` : actions}
     <h2>Comments (${comments.results.length})</h2>${commentRows(comments.results)}
     <h2>Uploads</h2>${list(versions.results, (v) => `<a href="/admin/versions/${v.id}">${esc(v.name)} ${esc(v.version)}</a> <span class="pill">${esc(v.status)}</span> <span class="muted">${esc(when(v.submitted_at))}</span>`)}
     <h2>Tickets</h2>${list(tickets.results, (t) => `<a href="${esc(support)}/tickets/${t.id}">#${t.id} ${esc(t.subject)}</a> <span class="pill">${esc(t.status)}</span> <span class="muted">${esc(when(t.created_at))}</span>`)}
     <h2>Language requests</h2>${list(languages.results, (l) => `${esc(l.name)} (${esc(l.code)}) <span class="pill">${esc(l.status)}</span> <span class="muted">${esc(when(l.created_at))}</span>`)}
     <h2>Accounts on the same networks</h2>${list(network, (n) => `${userLink(n.id, n.name)} ${flags(n)} <span class="muted">joined ${esc(when(n.created_at))}</span>`)}
     <h2>History</h2>${logTable(log.results)}`,
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function userAction(req: Request, env: Env, actor: User, id: string): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  if (id === actor.id || env.ADMINS.split(",").map((s) => s.trim()).includes(id)) return userPage(env, actor, id, "Admins can't be moderated here.");
  const u = await env.DB.prepare("SELECT banned, shadowbanned FROM users WHERE id = ? AND deleted_at = 0").bind(id).first<{ banned: number; shadowbanned: number }>();
  if (!u) return userPage(env, actor, id);
  const before = { banned: u.banned, shadowbanned: u.shadowbanned };
  const flip: Record<string, Record<string, number>> = { ban: { banned: 1 }, unban: { banned: 0 }, shadow: { shadowbanned: 1 }, unshadow: { shadowbanned: 0 } };
  if (flip[action]) {
    const changes: Change[] = [{ kind: "user", id, before, after: { ...before, ...flip[action] } }];
    if (action === "ban") {
      // Pending uploads are rejected with the ban, as before.
      const pending = await env.DB.prepare("SELECT id, reason, reviewed_at FROM versions WHERE submitted_by = ? AND status = 'pending'").bind(id).all<{ id: number; reason: string; reviewed_at: number | null }>();
      for (const v of pending.results) changes.push({ kind: "version", id: v.id, before: { status: "pending", reason: v.reason, reviewed_at: v.reviewed_at }, after: { status: "rejected", reason: "Account banned", reviewed_at: Date.now() } });
    }
    await record(env, actor.id, action, { kind: "user", id }, String(form.get("reason") ?? ""), changes);
    if (action === "ban") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    const back = String(form.get("back") ?? "");
    return redirect(back.startsWith("/admin/") ? back : `/admin/users/${encodeURIComponent(id)}`);
  }
  if (action === "rollback") {
    const ids = form.get("everyone") === "1" ? [id, ...(await sameNetwork(env, id)).map((n) => n.id)] : [id];
    return userPage(env, actor, id, await rollbackMany(env, actor, ids, since(form), banMode(form), form.get("network") === "1"));
  }
  return new Response("Bad request", { status: 400 });
}

// The log

interface LogRow {
  id: number;
  actor_id: string | null;
  action: string;
  target_kind: string;
  target_id: string;
  detail: string;
  created_at: number;
  undone_at: number | null;
  undone_by: string | null;
  changes?: number;
}

function logTable(rows: LogRow[]): string {
  if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
  return `<table class="mod"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th><th></th></tr></thead><tbody>${rows
    .map((r) => {
      const target = r.target_kind === "user" ? userLink(r.target_id, r.target_id) : `${esc(r.target_kind)} ${esc(r.target_id)}`;
      const state =
        r.undone_at === 0
          ? ""
          : r.undone_at
            ? `<span class="pill">undone ${esc(when(r.undone_at))}</span>`
            : `<form class="inline" method="post" action="/admin/moderation/log/${r.id}/undo"><button class="ghost small">Undo</button></form>`;
      return `<tr><td>${esc(when(r.created_at))}</td><td class="mono">${esc(r.actor_id ?? "system")}</td><td>${esc(r.action)}</td><td>${target}</td><td>${esc(r.detail)}${r.changes ? ` <span class="muted">(${r.changes} changes)</span>` : ""}</td><td>${state}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

export async function logPage(env: Env, user: User, notice = ""): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT l.*, (SELECT COUNT(*) FROM moderation_changes WHERE log_id = l.id) AS changes FROM moderation_log l ORDER BY l.created_at DESC, l.id DESC LIMIT 300",
  ).all<LogRow>();
  return page(
    "Moderation log",
    user,
    true,
    `${MOD_CSS}<p class="crumbs"><a href="/admin/moderation">Moderation</a></p><h1>Moderation log</h1>${notice ? `<p class="risky">${esc(notice)}</p>` : ""}
     <p class="muted">Every action admins took, newest first. Undo puts back what it changed; sessions a ban signed out stay signed out.</p>${logTable(results)}`,
  );
}

export async function undoAction(env: Env, actor: User, id: number): Promise<Response> {
  const result = await undo(env, actor.id, id);
  if (!result) return logPage(env, actor, "That was already undone.");
  return logPage(env, actor, `Put back ${result.restored} change${result.restored === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} couldn't be (changed again since)` : ""}.`);
}

// Spam prevention shared by everything people can post: pack uploads, comments,
// tickets, language requests and translations. One screen() call per write
// checks blocks, lockdown, per-account and per-network limits, and says whether
// the post is held for review or shown only to its writer (a shadowban).
// Every moderation action is logged with what it changed, so it can be undone.

import { hash, isAdmin, type User } from "./auth.ts";
import { limit } from "./account-security.ts";
import { notify } from "./notifications.ts";
import { tp } from "./i18n.ts";
import type { Env } from "./index.ts";

/** Accounts this young, with nothing approved yet, get tighter limits. */
export const NEW_ACCOUNT_MS = 3 * 86400_000;
/** More comments than this from new accounts in an hour holds every new account's comments. */
export const FLOOD_PER_HOUR = 25;
/** A comment this many people report waits for review. */
export const REPORTS_TO_HOLD = 3;

/** Counts only what everyone sees: not deleted, removed, held, or from banned or shadowbanned accounts. */
export const VISIBLE_COMMENT = `c.deleted_at IS NULL AND c.removed_at IS NULL AND c.held = 0 AND cu.banned = 0 AND cu.shadowbanned = 0 AND cu.deactivated_at = 0 AND cu.deleted_at = 0`;

export type Action = "comment" | "pack" | "ticket" | "language" | "translation" | "report";

type Window = [max: number, seconds: number];
const LIMITS: Record<Action, { fresh?: Window; network: Window; account?: Window }> = {
  comment: { fresh: [4, 3600], network: [30, 3600] },
  pack: { fresh: [3, 86400], network: [15, 86400] },
  ticket: { fresh: [2, 3600], network: [10, 3600] },
  language: { fresh: [2, 86400], network: [10, 86400] },
  translation: { fresh: [40, 3600], network: [400, 3600] },
  report: { account: [20, 86400], network: [60, 86400] },
};

export type Verdict =
  | { ok: true; held: boolean; hidden: boolean; ipHash: string | null }
  | { ok: false; error: string; status: number };

export function clientIp(req: Request | null): string | null {
  return req?.headers.get("CF-Connecting-IP") ?? null;
}

/** A keyed hash of an address, so the database never holds one. */
export async function ipHash(env: Env, ip: string | null): Promise<string | null> {
  return ip ? (await hash(`ip:${env.IP_HASH_KEY ?? ""}:${ip}`)).slice(0, 32) : null;
}

export async function setting(env: Env, key: string, fallback = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM moderation_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export type Lockdown = "off" | "new" | "all";
export async function lockdown(env: Env): Promise<Lockdown> {
  const v = await setting(env, "lockdown", "off");
  return v === "new" || v === "all" ? v : "off";
}

/** Whether new accounts may be made. */
export async function signupsOpen(env: Env): Promise<boolean> {
  return (await setting(env, "signups", "open")) !== "closed";
}

export async function blocked(env: Env, kind: "ip" | "email" | "domain", value: string | null): Promise<boolean> {
  if (!value) return false;
  const row = await env.DB.prepare("SELECT 1 FROM blocklist WHERE kind = ? AND value = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(kind, value.toLowerCase(), Date.now())
    .first();
  return !!row;
}

/** Whether mail from this address is refused, by address or by domain. */
export async function blockedAddress(env: Env, email: string): Promise<boolean> {
  const domain = email.split("@")[1] ?? "";
  return (await blocked(env, "email", email)) || (!!domain && (await blocked(env, "domain", domain)));
}

interface Standing {
  created_at: number;
  shadowbanned: number;
  trusted: number;
}

async function standing(env: Env, user: User): Promise<Standing | null> {
  return env.DB.prepare(
    `SELECT created_at, shadowbanned, EXISTS (SELECT 1 FROM versions WHERE submitted_by = users.id AND status = 'approved') AS trusted
     FROM users WHERE id = ?`,
  )
    .bind(user.id)
    .first<Standing>();
}

export function isNew(s: Standing, now = Date.now()): boolean {
  return !s.trusted && s.created_at > now - NEW_ACCOUNT_MS;
}

/** Whether a signed-in account is still new; new accounts see Turnstile on comments. */
export async function isNewAccount(env: Env, user: User): Promise<boolean> {
  const s = await standing(env, user);
  return !s || isNew(s);
}

/**
 * Checks one write before it happens. `links` says the text carries web
 * addresses, which new accounts can't post without review.
 */
export async function screen(env: Env, req: Request | null, user: User, action: Action, opts: { links?: boolean } = {}): Promise<Verdict> {
  const ipHashed = await ipHash(env, clientIp(req));
  if (isAdmin(env, user)) return { ok: true, held: false, hidden: false, ipHash: ipHashed };
  const refuse = (error: string, status = 429): Verdict => ({ ok: false, error, status });
  if (user.banned) return refuse(tp("This account can't post."), 403);
  if (await blocked(env, "ip", ipHashed)) return refuse(tp("Posting from this network isn't allowed right now."), 403);
  const s = await standing(env, user);
  if (!s) return refuse(tp("This account can't post."), 403);
  const fresh = isNew(s);
  const mode = await lockdown(env);
  if (mode === "all" || (mode === "new" && fresh)) return refuse(tp("Posting is paused for a while. Try again later."), 503);
  const rules = LIMITS[action];
  if (rules.account && !(await limit(env, `mod-${action}`, user.id, ...rules.account))) return refuse(tp("That's a lot in a short time. Try again later."));
  if (fresh && rules.fresh && !(await limit(env, `mod-${action}-new`, user.id, ...rules.fresh))) {
    return refuse(tp("New accounts can only post a little at first. Try again later."));
  }
  if (ipHashed && !(await limit(env, `mod-${action}-ip`, ipHashed, ...rules.network))) return refuse(tp("That's a lot from one network in a short time. Try again later."));
  if (ipHashed) await env.DB.prepare("UPDATE users SET ip_hash = ? WHERE id = ?").bind(ipHashed, user.id).run();
  let held = false;
  if (action === "comment" && fresh) held = !!opts.links || (await flooding(env));
  return { ok: true, held, hidden: !!s.shadowbanned, ipHash: ipHashed };
}

/** Whether new accounts are commenting far more than usual. Tells admins once an hour. */
export async function flooding(env: Env): Promise<boolean> {
  const since = Date.now() - 3600_000;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.created_at > ? AND u.created_at > ?`,
  )
    .bind(since, Date.now() - NEW_ACCOUNT_MS)
    .first<{ n: number }>();
  const flood = (row?.n ?? 0) >= FLOOD_PER_HOUR;
  if (flood && (await limit(env, "flood-alert", "comments", 1, 3600))) {
    await notify(env, {
      title: "Comment flood",
      text: `New accounts posted ${row?.n} comments in the last hour. New accounts' comments now wait for review.`,
      url: `${env.SITE_URL}/admin/moderation`,
    });
  }
  return flood;
}

export function hasLinks(text: string): boolean {
  return /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ru|cn|xyz|top|io|co|info|biz|shop|site|online|click|link)\b/i.test(text);
}

// Turnstile

/** Whether the keys are there. The CSP allows the widget whenever they are. */
export function turnstileConfigured(env: Env): boolean {
  return !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET;
}

/** Whether forms ask for Turnstile: set up, and not switched off by an admin. */
export async function turnstileOn(env: Env): Promise<boolean> {
  return turnstileConfigured(env) && (await setting(env, "turnstile", "on")) !== "off";
}

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The challenge widget for a form, or nothing when Turnstile isn't set up. */
export async function turnstileWidget(env: Env): Promise<string> {
  if (!(await turnstileOn(env))) return "";
  const key = env.TURNSTILE_SITE_KEY!.replace(/[^A-Za-z0-9_-]/g, "");
  return `<div class="cf-turnstile" data-sitekey="${key}" data-theme="auto" data-size="flexible"></div><script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>`;
}

/** Checks the token a form sent. Passes when Turnstile isn't set up or is switched off. */
export async function passedTurnstile(env: Env, req: Request | null, token: unknown): Promise<boolean> {
  if (!(await turnstileOn(env))) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token });
  const ip = clientIp(req);
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`, { method: "POST", body, signal: AbortSignal.timeout(8000) });
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

export const TURNSTILE_FAILED = "Complete the check that you're a person, then try again.";

// The log, and undoing what it records

/** Tables a logged change may write, and the columns it may put back. */
const RESTORABLE: Record<string, { table: string; key: string; columns: string[] }> = {
  comment: { table: "comments", key: "id", columns: ["removed_at", "held"] },
  version: { table: "versions", key: "id", columns: ["status", "reason", "reviewed_at"] },
  pack: { table: "packs", key: "id", columns: ["listed"] },
  ticket: { table: "tickets", key: "id", columns: ["status"] },
  language: { table: "language_proposals", key: "id", columns: ["status", "reply", "decided_at"] },
  user: { table: "users", key: "id", columns: ["banned", "shadowbanned"] },
  report: { table: "reports", key: "id", columns: ["resolved_at", "resolved_by"] },
};

export interface Change {
  kind: keyof typeof RESTORABLE | "block";
  id: string | number;
  before: Record<string, unknown>;
  /** The values to write now. */
  after: Record<string, unknown>;
}

/**
 * Applies changes and logs them as one action, with the values before, in one
 * transaction. Returns the log entry's id.
 */
export async function record(
  env: Env,
  actor: string | null,
  action: string,
  target: { kind: string; id: string | number },
  detail: string,
  changes: Change[],
): Promise<number> {
  const now = Date.now();
  const log = await env.DB.prepare(
    "INSERT INTO moderation_log (actor_id, action, target_kind, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(actor, action, target.kind, String(target.id), detail.slice(0, 500), now)
    .first<{ id: number }>();
  const id = log!.id;
  const statements: D1PreparedStatement[] = [];
  for (const c of changes) {
    if (c.kind === "block") {
      // A block is added; undoing removes it.
      statements.push(
        env.DB.prepare("INSERT INTO blocklist (kind, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(
          c.after.kind,
          String(c.after.value).toLowerCase(),
          String(c.after.reason ?? "").slice(0, 200),
          actor,
          now,
        ),
      );
      statements.push(
        env.DB.prepare("INSERT OR IGNORE INTO moderation_changes (log_id, kind, item_id, before) VALUES (?, 'block', ?, ?)").bind(
          id,
          `${c.after.kind}:${String(c.after.value).toLowerCase()}`,
          "{}",
        ),
      );
      continue;
    }
    statements.push(update(env, c.kind, c.id, c.after));
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO moderation_changes (log_id, kind, item_id, before) VALUES (?, ?, ?, ?)").bind(id, c.kind, String(c.id), JSON.stringify(c.before)),
    );
  }
  for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));
  return id;
}

function update(env: Env, kind: string, id: string | number, values: Record<string, unknown>): D1PreparedStatement {
  const spec = RESTORABLE[kind];
  const columns = Object.keys(values).filter((c) => spec.columns.includes(c));
  if (!columns.length) throw new Error("Nothing to change");
  return env.DB.prepare(`UPDATE ${spec.table} SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE ${spec.key} = ?`).bind(
    ...columns.map((c) => values[c] ?? null),
    id,
  );
}

/** Puts back everything a logged action changed. Returns how many rows couldn't be. */
export async function undo(env: Env, actor: string, logId: number): Promise<{ restored: number; skipped: number } | null> {
  const log = await env.DB.prepare("SELECT * FROM moderation_log WHERE id = ? AND undone_at IS NULL").bind(logId).first();
  if (!log) return null;
  const { results } = await env.DB.prepare("SELECT kind, item_id, before FROM moderation_changes WHERE log_id = ?")
    .bind(logId)
    .all<{ kind: string; item_id: string; before: string }>();
  let restored = 0;
  let skipped = 0;
  for (const c of results) {
    try {
      if (c.kind === "block") {
        const [kind, ...rest] = c.item_id.split(":");
        await env.DB.prepare("DELETE FROM blocklist WHERE kind = ? AND value = ?").bind(kind, rest.join(":")).run();
      } else if (RESTORABLE[c.kind]) {
        await update(env, c.kind, c.item_id, JSON.parse(c.before)).run();
      } else continue;
      restored++;
    } catch {
      // A language reopened elsewhere since, for one.
      skipped++;
    }
  }
  await env.DB.prepare("UPDATE moderation_log SET undone_at = ?, undone_by = ? WHERE id = ?").bind(Date.now(), actor, logId).run();
  return { restored, skipped };
}

/** Logs an action that changes nothing undoable, like approving held comments. */
export async function note(env: Env, actor: string | null, action: string, target: { kind: string; id: string | number }, detail = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO moderation_log (actor_id, action, target_kind, target_id, detail, created_at, undone_at) VALUES (?, ?, ?, ?, ?, ?, 0)")
    .bind(actor, action, target.kind, String(target.id), detail.slice(0, 500), Date.now())
    .run();
}

// Rolling back an account

export type BanMode = "ban" | "shadow" | "none";

/**
 * Takes down everything an account posted since `since`: removes its comments,
 * rejects its uploads (listed packs fall back to their previous version),
 * unlists packs it started, marks its tickets spam, declines its language
 * requests, and bans it. One log entry, so one undo puts it all back.
 */
export async function rollbackAccount(
  env: Env,
  actor: string,
  userId: string,
  since: number,
  ban: BanMode,
  blockNetwork = false,
  reason = "",
): Promise<{ logId: number; counts: Record<string, number> } | null> {
  const user = await env.DB.prepare("SELECT id, banned, shadowbanned, ip_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; banned: number; shadowbanned: number; ip_hash: string | null }>();
  if (!user || env.ADMINS.split(",").map((s) => s.trim()).includes(userId)) return null;
  const now = Date.now();
  const changes: Change[] = [];
  const counts: Record<string, number> = { comments: 0, versions: 0, packs: 0, tickets: 0, languages: 0 };

  const comments = await env.DB.prepare("SELECT id, held FROM comments WHERE user_id = ? AND created_at >= ? AND removed_at IS NULL AND deleted_at IS NULL")
    .bind(userId, since)
    .all<{ id: number; held: number }>();
  for (const c of comments.results) changes.push({ kind: "comment", id: c.id, before: { removed_at: null, held: c.held }, after: { removed_at: now, held: 0 } });
  counts.comments = comments.results.length;

  const versions = await env.DB.prepare("SELECT id, status, reason, reviewed_at FROM versions WHERE submitted_by = ? AND submitted_at >= ? AND status != 'rejected'")
    .bind(userId, since)
    .all<{ id: number; status: string; reason: string; reviewed_at: number | null }>();
  for (const v of versions.results) {
    changes.push({ kind: "version", id: v.id, before: { status: v.status, reason: v.reason, reviewed_at: v.reviewed_at }, after: { status: "rejected", reason: "Removed by moderation", reviewed_at: now } });
  }
  counts.versions = versions.results.length;

  const packs = await env.DB.prepare("SELECT id FROM packs WHERE owner_id = ? AND created_at >= ? AND listed = 1").bind(userId, since).all<{ id: string }>();
  for (const p of packs.results) changes.push({ kind: "pack", id: p.id, before: { listed: 1 }, after: { listed: 0 } });
  counts.packs = packs.results.length;

  const tickets = await env.DB.prepare("SELECT id, status FROM tickets WHERE user_id = ? AND created_at >= ? AND status != 'spam'").bind(userId, since).all<{ id: number; status: string }>();
  for (const t of tickets.results) changes.push({ kind: "ticket", id: t.id, before: { status: t.status }, after: { status: "spam" } });
  counts.tickets = tickets.results.length;

  const languages = await env.DB.prepare("SELECT id, status, reply, decided_at FROM language_proposals WHERE user_id = ? AND created_at >= ? AND status = 'open'")
    .bind(userId, since)
    .all<{ id: number; status: string; reply: string; decided_at: number | null }>();
  for (const l of languages.results) {
    changes.push({ kind: "language", id: l.id, before: { status: l.status, reply: l.reply, decided_at: l.decided_at }, after: { status: "declined", reply: "Removed by moderation", decided_at: now } });
  }
  counts.languages = languages.results.length;

  if (ban !== "none") {
    changes.push({
      kind: "user",
      id: userId,
      before: { banned: user.banned, shadowbanned: user.shadowbanned },
      after: ban === "ban" ? { banned: 1, shadowbanned: user.shadowbanned } : { banned: user.banned, shadowbanned: 1 },
    });
  }
  if (blockNetwork) {
    for (const h of await networksOf(env, userId)) if (!(await blocked(env, "ip", h))) changes.push({ kind: "block", id: h, before: {}, after: { kind: "ip", value: h, reason: `Rollback of ${userId}` } });
  }
  const span = since > 0 ? `since ${new Date(since).toISOString()}` : "all time";
  const logId = await record(env, actor, "rollback", { kind: "user", id: userId }, `${span}; ${ban}${blockNetwork ? "; network blocked" : ""}${reason ? `; ${reason}` : ""}`, changes);
  // Signed-out sessions aren't put back by an undo; they sign in again.
  if (ban === "ban") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  return { logId, counts };
}

/** Every network hash an account has posted from. */
export async function networksOf(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT ip_hash FROM users WHERE id = ?1 AND ip_hash IS NOT NULL
     UNION SELECT ip_hash FROM comments WHERE user_id = ?1 AND ip_hash IS NOT NULL
     UNION SELECT ip_hash FROM versions WHERE submitted_by = ?1 AND ip_hash IS NOT NULL
     UNION SELECT ip_hash FROM tickets WHERE user_id = ?1 AND ip_hash IS NOT NULL
     UNION SELECT ip_hash FROM language_proposals WHERE user_id = ?1 AND ip_hash IS NOT NULL LIMIT 50`,
  )
    .bind(userId)
    .all<{ ip_hash: string }>();
  return results.map((r) => r.ip_hash);
}

/** Other accounts that posted from any network this one did. */
export async function sameNetwork(env: Env, userId: string): Promise<{ id: string; name: string; created_at: number; banned: number; shadowbanned: number }[]> {
  const nets = await networksOf(env, userId);
  if (!nets.length) return [];
  const marks = nets.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, name, created_at, banned, shadowbanned FROM users WHERE id != ? AND deleted_at = 0 AND id IN (
       SELECT id FROM users WHERE ip_hash IN (${marks})
       UNION SELECT user_id FROM comments WHERE ip_hash IN (${marks})
       UNION SELECT submitted_by FROM versions WHERE ip_hash IN (${marks})
       UNION SELECT user_id FROM tickets WHERE ip_hash IN (${marks}) AND user_id IS NOT NULL
       UNION SELECT user_id FROM language_proposals WHERE ip_hash IN (${marks}) AND user_id IS NOT NULL)
     ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(userId, ...nets, ...nets, ...nets, ...nets, ...nets)
    .all<{ id: string; name: string; created_at: number; banned: number; shadowbanned: number }>();
  return results;
}

// Reports

export async function report(env: Env, req: Request, user: User, kind: "comment" | "pack", itemId: string, reason: string): Promise<{ ok: true } | { error: string; status: number }> {
  const verdict = await screen(env, req, user, "report");
  if (!verdict.ok) return { error: verdict.error, status: verdict.status };
  const text = reason.replace(/\s+/g, " ").trim().slice(0, 300) || "No reason given";
  const exists =
    kind === "comment"
      ? await env.DB.prepare("SELECT user_id FROM comments WHERE id = ? AND deleted_at IS NULL AND removed_at IS NULL").bind(Number(itemId)).first<{ user_id: string }>()
      : await env.DB.prepare("SELECT owner_id AS user_id FROM packs WHERE id = ? AND listed = 1").bind(itemId).first<{ user_id: string }>();
  if (!exists) return { error: tp("That's already gone."), status: 404 };
  if (exists.user_id === user.id) return { error: tp("You can delete your own instead."), status: 400 };
  // A shadowbanned reporter's reports are quietly kept out of the count.
  if (verdict.hidden) return { ok: true };
  await env.DB.prepare("INSERT INTO reports (kind, item_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(kind, String(itemId), user.id, text, Date.now())
    .run();
  if (kind === "comment") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE kind = 'comment' AND item_id = ? AND resolved_at IS NULL").bind(String(itemId)).first<{ n: number }>();
    if ((n?.n ?? 0) >= REPORTS_TO_HOLD) await env.DB.prepare("UPDATE comments SET held = 1 WHERE id = ?").bind(Number(itemId)).run();
  }
  if (await limit(env, "report-alert", `${kind}:${itemId}`, 1, 86400)) {
    await notify(env, { title: `Report: ${kind}`, text: `${user.name} reported a ${kind}: ${text}`, url: `${env.SITE_URL}/admin/moderation#reports` });
  }
  return { ok: true };
}

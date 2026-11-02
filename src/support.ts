// The helpdesk at support.blockworked.com. Anyone signed in to the community
// site can file a ticket, and anyone can email support@. Staff answer here;
// every answer is emailed to whoever filed the ticket, and they can reply by
// email or on the ticket's page, which the emailed link opens without signing in.

import PostalMime from "postal-mime";
import { hash, isAdmin, logout, PROVIDERS, randomToken, type User } from "./auth.ts";
import type { Env } from "./index.ts";
import { esc, page, type Shell } from "./pages.ts";
import { commentHtml } from "./comments.ts";
import {
  cleanSubject,
  fromAddress,
  isAutomated,
  isEmail,
  MAX_BODY,
  messageId,
  normalizeEmail,
  sendMail,
  stripQuoted,
  ticketFromSubject,
  tidy,
} from "./support-mail.ts";

export type Status = "open" | "answered" | "closed";
const STATUS_LABEL: Record<Status, string> = { open: "Waiting on us", answered: "Waiting on you", closed: "Closed" };
const STAFF_LABEL: Record<Status, string> = { open: "Needs an answer", answered: "Answered", closed: "Closed" };

const NEW_TICKETS_PER_HOUR = 5;
const MAX_SUBJECT = 200;
// Cloudflare hands over at most 25 MiB; a support mail never needs that.
const MAX_RAW_EMAIL = 5 * 1024 * 1024;

export interface Ticket {
  id: number;
  subject: string;
  status: Status;
  email: string;
  name: string;
  user_id: string | null;
  access_key: string;
  created_at: number;
  updated_at: number;
}

interface TicketMessage {
  id: number;
  kind: "requester" | "staff" | "note";
  user_id: string | null;
  body: string;
  email_id: string | null;
  created_at: number;
  author: string | null;
  avatar: string | null;
}

export function isStaff(env: Env, user: User | null): boolean {
  if (!user || user.banned) return false;
  return isAdmin(env, user) || (env.SUPPORT_STAFF ?? "").split(",").map((s) => s.trim()).includes(user.id);
}

/** The helpdesk's address, without a trailing slash. */
export function supportUrl(env: Env): string {
  return (env.SUPPORT_URL || "https://support.blockworked.com").replace(/\/$/, "");
}

/**
 * The path under the helpdesk a request is for, or null when it isn't one:
 * every path on support.blockworked.com, or under SUPPORT_URL's own path when
 * that shares a host with the library (a local run).
 */
export function supportPath(env: Env, url: URL): string | null {
  const support = new URL(supportUrl(env));
  if (url.host !== support.host) return null;
  const base = support.pathname.replace(/\/$/, "");
  if (!base) return url.pathname;
  if (url.pathname === base) return "/";
  return url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : null;
}

function link(env: Env, path: string): string {
  return `${supportUrl(env)}${path}`;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function shell(env: Env, user: User | null, staff: boolean): Shell {
  const login = link(env, "/login");
  const nav = user
    ? `<a href="${link(env, "/")}">My tickets</a><a href="${link(env, "/new")}">New ticket</a>${staff ? `<a href="${link(env, "/queue")}">Queue</a>` : ""}
       <span class="who">${user.avatar ? `<img class="avatar" src="${esc(user.avatar)}" alt="">` : ""}${esc(user.name)}</span>
       <form class="inline" method="post" action="${link(env, "/logout")}"><button class="ghost">Sign out</button></form>`
    : `<a href="${esc(login)}">Sign in</a>`;
  return { name: "Support", href: link(env, "/"), nav, site: "Blockworked Support", place: { community: `${env.SITE_URL}/`, section: "support" } };
}

function when(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

function statusPill(status: Status, staff: boolean): string {
  return `<span class="ticket-status s-${status}">${esc((staff ? STAFF_LABEL : STATUS_LABEL)[status])}</span>`;
}


// Pages

export async function supportRoute(req: Request, env: Env, path: string, user: User | null): Promise<Response> {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const staff = isStaff(env, user);
  const url = new URL(req.url);
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/") return home(env, user, staff);
  if (method === "GET" && path === "/login") return loginPage(env, user, staff, url.searchParams.get("next") ?? "/");
  if (path === "/new") {
    if (!user) return redirect(link(env, `/login?next=${encodeURIComponent("/new")}`));
    if (method === "GET") return newForm(env, user, staff, "", {}, await savedEmail(env, user));
    if (method === "POST") return createFromForm(req, env, user, staff);
  }
  if (method === "GET" && path === "/queue") {
    if (!staff) return notFound(env, user, staff);
    return queue(env, user!, url.searchParams.get("status"));
  }
  if (method === "POST" && path === "/logout") return logout(req, env, link(env, "/"));
  if ((m = path.match(/^\/tickets\/(\d{1,9})(\/reply|\/status)?$/))) {
    const id = Number(m[1]);
    const key = method === "GET" ? url.searchParams.get("k") : null;
    if (method === "GET" && !m[2]) return ticketPage(env, user, staff, id, key);
    if (method === "POST" && m[2] === "/reply") return reply(req, env, user, staff, id);
    if (method === "POST" && m[2] === "/status") {
      if (!staff) return notFound(env, user, staff);
      return setStatus(req, env, id);
    }
  }
  return notFound(env, user, staff);
}

/** Sign-in on the helpdesk's own pages. The providers send everyone back to the
 *  library's address, whose cookie covers this host too, and on to `next` here. */
function loginPage(env: Env, user: User | null, staff: boolean, next: string): Response {
  const path = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (user) return redirect(link(env, path));
  const back = encodeURIComponent(link(env, path));
  const buttons = Object.entries(PROVIDERS)
    .map(([id, name]) => `<a class="button large" href="${esc(`${env.SITE_URL}/auth/${id}/login?next=${back}`)}">Sign in with ${esc(name)}</a>`)
    .join("");
  return page(
    "Sign in",
    null,
    false,
    `<h1>Sign in</h1><p class="muted">Use your Blockwork community account, or make one by signing in. You can also email
     <a href="mailto:${esc(fromAddress(env))}">${esc(fromAddress(env))}</a> without an account.</p><div class="signin">${buttons}</div>`,
    200,
    shell(env, null, false),
  );
}

function notFound(env: Env, user: User | null, staff: boolean): Response {
  return page("Not found", user, staff, `<h1>Not found</h1><p>There's nothing here.</p>`, 404, shell(env, user, staff));
}

async function home(env: Env, user: User | null, staff: boolean): Promise<Response> {
  const email = esc(fromAddress(env));
  const ways = `<div class="ways">
    <div class="card"><h3>File a ticket</h3><p class="muted">Sign in with your community account and tell us what's up. You can follow it here.</p>
      <p><a class="button primary" href="${link(env, "/new")}">New ticket</a></p></div>
    <div class="card"><h3>Email us</h3><p class="muted">Write to <a href="mailto:${email}">${email}</a>. No account needed; we'll answer by email.</p></div>
  </div>`;
  if (!user) {
    return page(
      "Support",
      null,
      false,
      `<h1>Blockworked Support</h1><p class="muted">Questions about Blockwork, the community library or your account? We're here to help.</p>${ways}`,
      200,
      shell(env, null, false),
    );
  }
  const { results } = await env.DB.prepare("SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200").bind(user.id).all<Ticket>();
  const list = results.length
    ? `<ul class="ticket-list">${results.map((t) => ticketRow(env, t, false)).join("")}</ul>`
    : `<p class="muted">You haven't filed any tickets.</p>`;
  return page(
    "Support",
    user,
    staff,
    `<h1>Blockworked Support</h1>${ways}<h2>Your tickets</h2>${list}
     <p class="muted">Tickets you emailed in are answered by email; their links open them here.</p>`,
    200,
    shell(env, user, staff),
  );
}

function ticketRow(env: Env, t: Ticket, staff: boolean): string {
  return `<li><a class="row" href="${link(env, `/tickets/${t.id}`)}"><span class="num">#${t.id}</span><span class="subject">${esc(t.subject)}</span>
    ${staff ? `<span class="who-from">${esc(t.name || t.email)}</span>` : ""}${statusPill(t.status, staff)}<span class="time">${esc(when(t.updated_at))}</span></a></li>`;
}

function newForm(env: Env, user: User, staff: boolean, error = "", draft: { subject?: string; body?: string; email?: string } = {}, savedEmail = ""): Response {
  return page(
    "New ticket",
    user,
    staff,
    `<h1>New ticket</h1>
     <form class="support-form comment-form" method="post" action="${link(env, "/new")}">
       ${error ? `<p class="risky">${esc(error)}</p>` : ""}
       <label class="field" for="email">Your email</label>
       <input type="email" id="email" name="email" required maxlength="254" autocomplete="email" value="${esc(draft.email ?? savedEmail)}">
       <p class="muted" style="font-size:13px;margin:6px 0 0">We email you when we answer. Only staff see it.</p>
       <label class="field" for="subject">Subject</label>
       <input type="text" id="subject" name="subject" required maxlength="${MAX_SUBJECT}" value="${esc(draft.subject ?? "")}">
       <label class="field" for="body">What's going on?</label>
       <textarea id="body" name="body" required maxlength="${MAX_BODY}" placeholder="What you were doing, what happened, and your Blockwork version if it's about the app">${esc(draft.body ?? "")}</textarea>
       <p class="form-foot"><span class="muted">Plain text. Links work.</span><button class="primary">Send</button></p>
     </form>`,
    error ? 400 : 200,
    shell(env, user, staff),
  );
}

async function savedEmail(env: Env, user: User): Promise<string> {
  const row = await env.DB.prepare("SELECT support_email FROM users WHERE id = ?").bind(user.id).first<{ support_email: string | null }>();
  return row?.support_email ?? "";
}

async function createFromForm(req: Request, env: Env, user: User, staff: boolean): Promise<Response> {
  const form = await req.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const subject = String(form.get("subject") ?? "").replace(/\s+/g, " ").trim();
  const body = tidy(String(form.get("body") ?? ""));
  const draft = { email, subject, body };
  if (user.banned) return newForm(env, user, staff, "This account can't file tickets.", draft);
  if (!isEmail(email)) return newForm(env, user, staff, "That email address doesn't look right.", draft);
  if (!subject) return newForm(env, user, staff, "Give it a subject.", draft);
  if (subject.length > MAX_SUBJECT) return newForm(env, user, staff, `Subjects can be up to ${MAX_SUBJECT} characters.`, draft);
  if (!body) return newForm(env, user, staff, "Write something first.", draft);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND created_at > ?")
    .bind(user.id, Date.now() - 3600_000)
    .first<{ n: number }>();
  if (!staff && (recent?.n ?? 0) >= NEW_TICKETS_PER_HOUR) return newForm(env, user, staff, "That's a lot of tickets in an hour. Try again later.", draft);
  await env.DB.prepare("UPDATE users SET support_email = ? WHERE id = ?").bind(email, user.id).run();
  const { ticket } = await openTicket(env, { subject, body, email, name: user.name, userId: user.id, emailId: null });
  return redirect(link(env, `/tickets/${ticket.id}`));
}

/** Files a ticket and sends the receipt and the staff notice. Returns it and its key. */
export async function openTicket(
  env: Env,
  t: { subject: string; body: string; email: string; name: string; userId: string | null; emailId: string | null },
): Promise<{ ticket: Ticket; key: string }> {
  const now = Date.now();
  const key = randomToken();
  const ticket = (await env.DB.prepare(
    "INSERT INTO tickets (subject, status, email, name, user_id, access_key, created_at, updated_at) VALUES (?, 'open', ?, ?, ?, ?, ?, ?) RETURNING *",
  )
    .bind(t.subject, t.email, t.name.slice(0, 120), t.userId, key, now, now)
    .first<Ticket>())!;
  const first = await env.DB.prepare(
    "INSERT INTO ticket_messages (ticket_id, kind, user_id, body, email_id, created_at) VALUES (?, 'requester', ?, ?, ?, ?) RETURNING id",
  )
    .bind(ticket.id, t.userId, t.body, t.emailId, now)
    .first<{ id: number }>();
  const receiptId = messageId(env, ticket.id, first!.id);
  // The receipt is what an emailed reply answers when the ticket came from the site.
  if (!t.emailId) await env.DB.prepare("UPDATE ticket_messages SET email_id = ? WHERE id = ?").bind(receiptId, first!.id).run();
  await Promise.all([
    sendMail(env, {
      to: [t.email],
      subject: `[#${ticket.id}] ${ticket.subject}`,
      text: `Thanks for getting in touch. We've got your message and will answer as soon as we can.\n\nTo add anything, reply to this email or open the ticket:\n${keyLink(env, ticket.id, key)}\n\n---\n${t.body}`,
      messageId: receiptId,
      inReplyTo: t.emailId ?? undefined,
      references: t.emailId ? [t.emailId] : undefined,
      automated: true,
    }),
    notifyStaff(env, ticket, `New ticket from ${t.name || t.email} <${t.email}>`, t.body),
  ]);
  return { ticket, key };
}

function keyLink(env: Env, id: number, key: string): string {
  return link(env, `/tickets/${id}?k=${encodeURIComponent(key)}`);
}

async function notifyStaff(env: Env, ticket: Ticket, headline: string, body: string): Promise<void> {
  const to = (env.SUPPORT_NOTIFY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return;
  await sendMail(env, {
    to,
    subject: `[#${ticket.id}] ${ticket.subject}`,
    text: `${headline}\n\n${body}\n\n---\nAnswer it here (replies to this email aren't read):\n${link(env, `/tickets/${ticket.id}`)}`,
    automated: true,
  });
}

/** Whether this visitor may read the ticket: staff, the account that filed it, or the emailed key. */
async function canRead(env: Env, user: User | null, staff: boolean, t: Ticket, key: string | null): Promise<boolean> {
  if (staff) return true;
  if (user && !user.banned && t.user_id === user.id) return true;
  return !!key && (await hash(key)) === (await hash(t.access_key));
}

async function loadTicket(env: Env, id: number): Promise<Ticket | null> {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Ticket>();
}

async function ticketPage(env: Env, user: User | null, staff: boolean, id: number, key: string | null, error = "", draft = ""): Promise<Response> {
  const t = await loadTicket(env, id);
  if (!t || !(await canRead(env, user, staff, t, key))) return notFound(env, user, staff);
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.user_id, m.body, m.email_id, m.created_at, u.name AS author, u.avatar AS avatar
     FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.created_at, m.id LIMIT 500`,
  )
    .bind(id)
    .all<TicketMessage>();
  const items = results
    .filter((m) => staff || m.kind !== "note")
    .map((m) => {
      const name = m.kind === "requester" ? m.author || t.name || t.email : `${m.author || "Blockworked"}${m.kind === "note" ? "" : " (Blockworked)"}`;
      const pill = m.kind === "note" ? ` <span class="mark">internal note</span>` : m.kind === "staff" && staff ? ` <span class="mark">staff</span>` : "";
      const avatar = m.avatar
        ? `<img class="avatar" src="${esc(m.avatar)}" alt="">`
        : `<span class="avatar blank" aria-hidden="true">${esc((name || "?").slice(0, 1).toUpperCase())}</span>`;
      return `<li class="comment ${m.kind}" id="m-${m.id}">${avatar}<div class="comment-main"><div class="comment-meta"><strong>${esc(name)}</strong>${pill}
        <a class="muted" href="#m-${m.id}">${esc(when(m.created_at))}</a></div><p class="comment-body">${commentHtml(m.body)}</p></div></li>`;
    })
    .join("");
  const action = link(env, `/tickets/${t.id}/reply`);
  const keyField = key ? `<input type="hidden" name="k" value="${esc(key)}">` : "";
  const replyForm = `<form class="comment-form" method="post" action="${action}" id="reply">${keyField}
      ${error ? `<p class="risky">${esc(error)}</p>` : ""}
      <label class="sr" for="body">Reply</label>
      <textarea id="body" name="body" rows="6" required maxlength="${MAX_BODY}" placeholder="${staff ? `Your answer is emailed to ${esc(t.email)}` : "Add a reply"}">${esc(draft)}</textarea>
      <p class="form-foot"><span class="muted">${staff ? "Plain text. A note stays here and isn't emailed." : t.status === "closed" ? "Replying opens the ticket again." : "Plain text. Links work."}</span>
      <span>${staff ? `<button name="kind" value="note">Add note</button> ` : ""}<button class="primary" name="kind" value="${staff ? "staff" : "requester"}">${staff ? "Send answer" : "Send reply"}</button></span></p>
    </form>`;
  const staffBits = staff
    ? `<p class="muted meta"><span>From ${esc(t.name ? `${t.name} <${t.email}>` : t.email)}</span>${t.user_id ? `<span>account ${esc(t.user_id)}</span>` : "<span>by email</span>"}<span>opened ${esc(when(t.created_at))}</span></p>
       <form class="ticket-actions" method="post" action="${link(env, `/tickets/${t.id}/status`)}">
         ${t.status === "closed" ? `<button name="status" value="open">Reopen</button>` : `<button name="status" value="closed">Close</button>`}
         ${t.status === "open" ? `<button class="ghost" name="status" value="answered">Mark answered</button>` : ""}
       </form>`
    : `<p class="muted meta"><span>Opened ${esc(when(t.created_at))}</span></p>`;
  const crumbs = staff ? `<p class="crumbs"><a href="${link(env, "/queue")}">Queue</a></p>` : user ? `<p class="crumbs"><a href="${link(env, "/")}">My tickets</a></p>` : "";
  return page(
    `#${t.id} ${t.subject}`,
    user,
    staff,
    `${crumbs}<h1>${esc(t.subject)} <span class="version">#${t.id}</span></h1>
     <p>${statusPill(t.status, staff)}</p>${staffBits}
     <ol class="thread comment-list">${items}</ol>${replyForm}`,
    error ? 400 : 200,
    shell(env, user, staff),
  );
}

async function reply(req: Request, env: Env, user: User | null, staff: boolean, id: number): Promise<Response> {
  const form = await req.formData();
  const key = String(form.get("k") ?? "") || null;
  const t = await loadTicket(env, id);
  if (!t || !(await canRead(env, user, staff, t, key))) return notFound(env, user, staff);
  const body = tidy(String(form.get("body") ?? ""));
  const asked = String(form.get("kind") ?? "");
  const kind = staff ? (asked === "note" ? "note" : "staff") : "requester";
  if (!body) return ticketPage(env, user, staff, id, key, "Write something first.", "");
  await addMessage(env, t, kind, staff || t.user_id === user?.id ? (user?.id ?? null) : null, body, null);
  const back = key ? `/tickets/${id}?k=${encodeURIComponent(key)}` : `/tickets/${id}`;
  return redirect(link(env, back));
}

/** Adds to a ticket's thread, moves its status along and sends whatever email that calls for. */
export async function addMessage(env: Env, t: Ticket, kind: "requester" | "staff" | "note", userId: string | null, body: string, emailId: string | null): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO ticket_messages (ticket_id, kind, user_id, body, email_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(t.id, kind, userId, body, emailId, now)
    .first<{ id: number }>();
  const status: Status = kind === "requester" ? "open" : kind === "staff" ? "answered" : t.status;
  await env.DB.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, t.id).run();
  if (kind === "requester") {
    await notifyStaff(env, t, `${t.name || t.email} replied${t.status === "closed" ? " and reopened it" : ""}:`, body);
  } else if (kind === "staff") {
    // Threads under everything sent or received so far, so mail apps keep one conversation.
    const { results } = await env.DB.prepare("SELECT email_id FROM ticket_messages WHERE ticket_id = ? AND email_id IS NOT NULL ORDER BY id")
      .bind(t.id)
      .all<{ email_id: string }>();
    const refs = results.map((r) => r.email_id).slice(-20);
    const outgoing = messageId(env, t.id, row!.id);
    await env.DB.prepare("UPDATE ticket_messages SET email_id = ? WHERE id = ?").bind(outgoing, row!.id).run();
    await sendMail(env, {
      to: [t.email],
      subject: `Re: [#${t.id}] ${t.subject}`,
      text: `${body}\n\n---\nReply to this email to answer, or see the whole conversation:\n${keyLink(env, t.id, t.access_key)}`,
      messageId: outgoing,
      inReplyTo: refs[refs.length - 1],
      references: refs,
    });
  }
}

async function setStatus(req: Request, env: Env, id: number): Promise<Response> {
  const status = String((await req.formData()).get("status") ?? "");
  if (status !== "open" && status !== "answered" && status !== "closed") return new Response("Bad request", { status: 400 });
  await env.DB.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").bind(status, Date.now(), id).run();
  return redirect(link(env, `/tickets/${id}`));
}

async function queue(env: Env, user: User, wanted: string | null): Promise<Response> {
  const status: Status = wanted === "answered" || wanted === "closed" ? wanted : "open";
  const { results } = await env.DB.prepare(
    `SELECT * FROM tickets WHERE status = ? ORDER BY ${status === "open" ? "updated_at ASC" : "updated_at DESC"} LIMIT 300`,
  )
    .bind(status)
    .all<Ticket>();
  const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status").all<{ status: Status; n: number }>();
  const count = (s: Status) => counts.results.find((r) => r.status === s)?.n ?? 0;
  const tabs = (["open", "answered", "closed"] as Status[])
    .map((s) => `<a href="${link(env, `/queue?status=${s}`)}"${s === status ? ` aria-current="page"` : ""}>${esc(STAFF_LABEL[s])} <span class="n">${count(s)}</span></a>`)
    .join("");
  const list = results.length
    ? `<ul class="ticket-list">${results.map((t) => ticketRow(env, t, true)).join("")}</ul>`
    : `<p class="muted">${status === "open" ? "Nothing waiting. Nice." : "None."}</p>`;
  return page("Queue", user, true, `<h1>Support queue</h1><nav class="tabs" aria-label="Status">${tabs}</nav>${list}`, 200, shell(env, user, true));
}

// Email in

interface InboundEmail {
  from: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  setReject(reason: string): void;
}

/** A message Cloudflare Email Routing delivered to support@: a reply to a ticket, or a new one. */
export async function receiveEmail(message: InboundEmail, env: Env): Promise<void> {
  if (message.rawSize > MAX_RAW_EMAIL) {
    message.setReject("Message too large; please send it without attachments.");
    return;
  }
  if (isAutomated((name) => message.headers.get(name))) return;
  const parsed = await PostalMime.parse(message.raw);
  const from = normalizeEmail(parsed.from?.address || message.from);
  if (!isEmail(from) || from === normalizeEmail(fromAddress(env))) return;
  const name = (parsed.from?.name ?? "").trim();
  const emailId = (parsed.messageId ?? "").trim() || null;
  // A resent message (a retry, or the same mail to two of our addresses) lands once.
  if (emailId && (await env.DB.prepare("SELECT 1 FROM ticket_messages WHERE email_id = ?").bind(emailId).first())) return;
  const text = parsed.text?.trim() ? parsed.text : htmlToText(parsed.html ?? "");
  const attachments = parsed.attachments?.length ?? 0;
  const note = attachments ? `\n\n(${attachments} attachment${attachments === 1 ? "" : "s"} not kept; ask them to link it instead.)` : "";

  const ticket = await findTicket(env, from, parsed.inReplyTo ?? "", parsed.references ?? "", parsed.subject ?? "");
  if (ticket) {
    const body = tidy(stripQuoted(text)) || "(empty reply)";
    await addMessage(env, ticket, "requester", null, body + note, emailId);
    return;
  }
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE email = ? AND created_at > ?")
    .bind(from, Date.now() - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= NEW_TICKETS_PER_HOUR) return;
  const body = tidy(text) || "(empty message)";
  await openTicket(env, { subject: cleanSubject(parsed.subject ?? ""), body: body + note, email: from, name, userId: null, emailId });
}

/** The ticket an email answers: by the ids it replies to, else the [#n] in its subject. Only the requester's own address counts. */
async function findTicket(env: Env, from: string, inReplyTo: string, references: string, subject: string): Promise<Ticket | null> {
  const ids = `${inReplyTo} ${references}`.match(/<[^<>\s]+>/g) ?? [];
  for (const id of ids.reverse().slice(0, 20)) {
    const row = await env.DB.prepare("SELECT t.* FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id WHERE m.email_id = ?").bind(id).first<Ticket>();
    if (row && normalizeEmail(row.email) === from) return row;
  }
  const n = ticketFromSubject(subject);
  if (n) {
    const row = await loadTicket(env, n);
    if (row && normalizeEmail(row.email) === from) return row;
  }
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

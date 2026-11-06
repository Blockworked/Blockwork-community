// Mail sent to support@: Cloudflare Email Routing hands each message to
// receiveEmail, which files it as a reply to its ticket or as a new ticket.

import PostalMime from "postal-mime";
import type { Env } from "./index.ts";
import { addMessage, loadTicket, NEW_TICKETS_PER_HOUR, openTicket, type Ticket } from "./support.ts";
import {
  cleanSubject,
  fromAddress,
  isAutomated,
  isEmail,
  normalizeEmail,
  stripQuoted,
  ticketFromSubject,
  tidy,
} from "./support-mail.ts";

// Cloudflare hands over at most 25 MiB; a support mail never needs that.
const MAX_RAW_EMAIL = 5 * 1024 * 1024;

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

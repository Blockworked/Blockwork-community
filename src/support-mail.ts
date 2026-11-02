// Email for the helpdesk: reading what Cloudflare Email Routing hands the
// Worker for support@, and sending through smtp2go's HTTP API.

import type { Env } from "./index.ts";

export const MAX_BODY = 20000;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isEmail(raw: string): boolean {
  return raw.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z0-9-]{2,}$/i.test(raw.trim());
}

/** The ticket number in a subject like "Re: [#42] Can't sign in". */
export function ticketFromSubject(subject: string): number | null {
  const m = subject.match(/\[#(\d{1,9})\]/);
  return m ? Number(m[1]) : null;
}

/** The subject without reply prefixes or our ticket tag, for a new ticket. */
export function cleanSubject(subject: string): string {
  let s = subject.replace(/\[#\d{1,9}\]/g, " ");
  while (/^\s*(re|fwd?|aw|sv|antw)\s*:/i.test(s)) s = s.replace(/^\s*(re|fwd?|aw|sv|antw)\s*:/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return (s || "(no subject)").slice(0, 200);
}

/**
 * The new part of an emailed reply: everything above the "On ... wrote:" line
 * or the first block of quoted lines. Falls back to the whole text when the
 * cut would leave nothing.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    if (/^On .{4,200}wrote:\s*$/.test(line) || (/^On .{4,200}/.test(line) && /wrote:\s*$/.test(next))) {
      end = i;
      break;
    }
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{10,}$/.test(line) || /^From: .+/.test(line) && /^(Sent|Date): /.test(next)) {
      end = i;
      break;
    }
    if (/^>/.test(line) && lines.slice(i).every((l) => /^>/.test(l) || !l.trim())) {
      end = i;
      break;
    }
  }
  const kept = tidy(lines.slice(0, end).join("\n"));
  return kept || tidy(text);
}

export function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_BODY);
}

/** Auto-replies and bulk mail, which must never open tickets or get answers (mail loops). */
export function isAutomated(header: (name: string) => string | null): boolean {
  const auto = (header("auto-submitted") ?? "no").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  const precedence = (header("precedence") ?? "").trim().toLowerCase();
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return true;
  return !!header("x-autoreply") || !!header("x-autorespond") || !!header("list-id");
}

/** A Message-ID of ours, so a reply's In-Reply-To finds its ticket. */
export function messageId(env: Env, ticket: number, message: number): string {
  return `<ticket-${ticket}-${message}.${crypto.randomUUID().slice(0, 8)}@${fromAddress(env).split("@")[1]}>`;
}

export function fromAddress(env: Env): string {
  return env.SUPPORT_FROM || "support@blockworked.com";
}

export interface Outgoing {
  to: string[];
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** A receipt or notice rather than a person's words. */
  automated?: boolean;
}

/** Sends through smtp2go. Without an API key (local runs) it only logs. Never throws. */
export async function sendMail(env: Env, mail: Outgoing): Promise<boolean> {
  if (!mail.to.length) return true;
  if (!env.SMTP2GO_API_KEY) {
    console.log(`[mail not sent: no SMTP2GO_API_KEY] to ${mail.to.join(", ")}: ${mail.subject}\n${mail.text}`);
    return false;
  }
  const headers = [{ header: "Reply-To", value: fromAddress(env) }];
  // Tells other robots not to answer this one.
  if (mail.automated) headers.push({ header: "Auto-Submitted", value: "auto-generated" });
  if (mail.messageId) headers.push({ header: "Message-ID", value: mail.messageId });
  if (mail.inReplyTo) headers.push({ header: "In-Reply-To", value: mail.inReplyTo });
  if (mail.references?.length) headers.push({ header: "References", value: mail.references.join(" ") });
  try {
    const res = await fetch("https://api.smtp2go.com/v3/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Smtp2go-Api-Key": env.SMTP2GO_API_KEY },
      body: JSON.stringify({
        sender: `Blockworked Support <${fromAddress(env)}>`,
        to: mail.to,
        subject: mail.subject,
        text_body: mail.text,
        custom_headers: headers,
      }),
    });
    if (!res.ok) {
      console.error(`smtp2go refused mail to ${mail.to.join(", ")}: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("smtp2go unreachable", e);
    return false;
  }
}

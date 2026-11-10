// Provider sign-in and shared cookie sessions backed by D1.

import type { Env } from "./index.ts";

export interface User {
  id: string;
  name: string;
  avatar: string;
  banned: number;
}

const SESSION_DAYS = 30;
export const PROVIDERS = { github: "GitHub", google: "Google" } as const;
export type Provider = keyof typeof PROVIDERS;

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cookie(req: Request, name: string): string | null {
  return cookies(req, name)[0] ?? null;
}

/** Every value sent under a name: a host-only and a domain-wide session can both arrive. */
export function cookies(req: Request, name: string): string[] {
  const found: string[] = [];
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) found.push(v.join("="));
  }
  return found;
}

function setCookie(name: string, value: string, maxAge: number, path = "/", domain = ""): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax${domain ? `; Domain=${domain}` : ""}`;
}

/** The session cookie, shared with the helpdesk's host when COOKIE_DOMAIN is set.
 *  Also clears the host-only one older sign-ins left, so only one is ever sent. */
export function sessionCookies(env: Env, token: string, maxAge: number): string[] {
  const out = [setCookie("session", token, maxAge, "/", env.COOKIE_DOMAIN ?? "")];
  if (env.COOKIE_DOMAIN) out.unshift(setCookie("session", "", 0));
  return out;
}

export function isAdmin(env: Env, user: User | null): boolean {
  return !!user && env.ADMINS.split(",").map((s) => s.trim()).includes(user.id);
}

/**
 * Names only the Blockworked team account may use. Compared after folding case, accents,
 * spaces and punctuation, and 0/1 lookalikes, so "Block-Work" and "BL0CKWORKED" count too.
 */
const RESERVED_NAMES = ["blockwork", "blockworked"];

export function isReservedName(name: string): boolean {
  const folded = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/[^a-z]/g, "");
  return RESERVED_NAMES.includes(folded);
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  for (const token of cookies(req, "session").slice(0, 2)) {
    const user = await env.DB.prepare(
      "SELECT u.id, u.name, u.avatar, u.banned FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND s.kind = 'web' AND u.deactivated_at = 0 AND u.deleted_at = 0",
    )
      .bind(await hash(token), Date.now())
      .first<User>();
    // Sessions from before the name was reserved stop working.
    if (user && !user.banned) return isReservedName(user.name) && !isAdmin(env, user) ? null : user;
  }
  return null;
}

/** Only same-site paths or the helpdesk, so a login link can't bounce someone to another site. */
export function safeNext(next: string | null, env?: Pick<Env, "SUPPORT_URL">): string {
  if (next && /[\u0000-\u0020\u007f\\]/.test(next)) return "/";
  if (next?.startsWith("/")) {
    try {
      const parsed = new URL(next, "https://redirect.invalid");
      if (parsed.origin === "https://redirect.invalid") return parsed.pathname + parsed.search + parsed.hash;
    } catch {}
    return "/";
  }
  if (next && env?.SUPPORT_URL) {
    try {
      const support = new URL(env.SUPPORT_URL);
      const url = new URL(next);
      if (url.origin === support.origin && url.pathname.startsWith(support.pathname)) return url.toString();
    } catch {}
  }
  return "/";
}

/**
 * Sign-ins from before COOKIE_DOMAIN have a host-only cookie the helpdesk never
 * sees. Re-issues it domain-wide once, marked by the "sd" cookie.
 */
export function shareSession(req: Request, env: Env, headers: Headers): void {
  if (!env.COOKIE_DOMAIN || cookie(req, "sd")) return;
  const found = cookies(req, "session");
  if (found.length !== 1 || !found[0]) return;
  for (const c of sessionCookies(env, found[0], SESSION_DAYS * 86400)) headers.append("Set-Cookie", c);
  headers.append("Set-Cookie", setCookie("sd", "1", SESSION_DAYS * 86400, "/", env.COOKIE_DOMAIN));
}

export async function logout(req: Request, env: Env, to = "/"): Promise<Response> {
  for (const token of cookies(req, "session").slice(0, 2)) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hash(token)).run();
  }
  const headers = new Headers({ Location: to });
  headers.append("Set-Cookie", setCookie("session", "", 0));
  if (env.COOKIE_DOMAIN) headers.append("Set-Cookie", setCookie("session", "", 0, "/", env.COOKIE_DOMAIN));
  return new Response(null, { status: 303, headers });
}

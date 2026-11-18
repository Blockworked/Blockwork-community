// The Blockwork community block library: serves index.json and the pack files
// Blockwork downloads, and takes reviewed submissions from signed-in accounts.

import { webLateGithubHook } from './weblate-hooks.ts';
import { translationSite, translationLink } from './translation-site.ts';
import { translateRoute } from './translate.ts';
import { inLanguage, negotiate, tp } from './i18n.ts';
import { cleanupAccountObjects } from './account-lifecycle.ts';
import { profilePicture } from './profile.ts';
import { AuthBusyError } from "./account-security.ts";
import { localAuth } from "./local-auth.ts";
import { login, callback } from "./oauth.ts";
import { currentUser, shareSession, isAdmin, logout, PROVIDERS, type Provider, type User } from "./auth.ts";
import { esc, loginPage, message, page } from "./pages.ts";
import { authorPage, home, packCard, packPage, published, sourcePage, withBlockViews, type VersionRow } from "./browse.ts";
import { deleteComment, postComment } from "./comments.ts";
import { BROWSE_JS, redraw, renderFile, rendersPage, saveRenders, viewerUrl } from "./renders.ts";
import { idPart, OFFICIAL_OWNER } from "./packs.ts";
import { acceptUpload, api, appLoginConfirm, appLoginPage } from "./api.ts";
import { FONTS } from "./fonts.ts";
import { FAVICON_PNG, LOGO_PNG } from "./logo.ts";
import { setMainSite, SITE_JS } from "./site-nav.ts";
import { supportPath, supportRoute, supportUrl } from "./support.ts";
import { receiveEmail } from "./support-inbound.ts";
import { bulkVersions, reviewDecision, reviewFile, reviewPage, reviewQueue, setListed } from "./admin.ts";
import { blocklistAction, bulkAccounts, bulkComments, logPage, moderationPage, reportAction, settingsAction, undoAction, userAction, userPage } from "./moderation-admin.ts";
import { passedTurnstile, report, TURNSTILE_FAILED, TURNSTILE_ORIGIN, turnstileConfigured, turnstileWidget } from "./moderation.ts";

export interface Env {
  DB: D1Database;
  /** Weblate origin and explicit public project/component allowlist. */
  WEBLATE_URL?: string;
  /** Public UI address; Weblate itself uses a different origin. */
  TRANSLATE_URL?: string;
  WEBLATE_COMPONENTS?: string;
  WEBLATE_TRANSLATION_LICENSE?: string;
  /** Read-only project-scoped token and HMAC signing key: Worker secrets. */
  WEBLATE_READ_TOKEN?: string;
  WEBLATE_SHARED_SECRET?: string;
  /** A Weblate token allowed only to add languages to the listed components. */
  WEBLATE_LANGUAGE_TOKEN?: string;
  /** Enable only after migration, verified mail sender and adequate Workers CPU are configured. */
  LOCAL_AUTH_ENABLED?: string;
  AUTH_FROM?: string;
  USERNAME_COOLDOWN_DAYS?: string;
  /** 32 random bytes encoded as unpadded base64url. A Worker secret, never a variable. */
  AUTH_TOTP_KEY?: string;
  PACKS: R2Bucket;
  SITE_URL: string;
  /** blockworked.com, which the shared top nav links to. */
  MAIN_SITE_URL?: string;
  LIBRARY_NAME: string;
  /** Comma-separated account ids, like "github:123". */
  ADMINS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** The helpdesk, https://support.blockworked.com (support.ts). */
  SUPPORT_URL?: string;
  /** The address tickets are emailed from and to. */
  SUPPORT_FROM?: string;
  /** Comma-separated addresses told about new tickets and replies. */
  SUPPORT_NOTIFY?: string;
  /** Optional staff push channels; topic and webhook URL are secrets. */
  NTFY_URL?: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  DISCORD_WEBHOOK_URL?: string;
  /** Comma-separated account ids who answer tickets, besides ADMINS. */
  SUPPORT_STAFF?: string;
  /** Set to blockworked.com so a sign-in here also signs in on the helpdesk. */
  COOKIE_DOMAIN?: string;
  /** smtp2go API key for sending ticket email (a secret). */
  SMTP2GO_API_KEY?: string;
  /** Cloudflare Turnstile on sign-up, tickets, uploads and new accounts' comments. Off unless both are set. */
  TURNSTILE_SITE_KEY?: string;
  /** A secret. */
  TURNSTILE_SECRET?: string;
  /** Keys the network hashes moderation keeps (a secret), so they can't be reversed by guessing addresses. */
  IP_HASH_KEY?: string;
}

function securityHeaders(env: Env, loopbackForm = false): Record<string, string> {
  // The pack viewer is Blockwork's editor on blockworked.com (renders.ts).
  const viewer = new URL(viewerUrl(env)).origin;
  // The app sign-in page's form answers Blockwork on this computer.
  const formAction = loopbackForm ? "'self' http://127.0.0.1:*" : "'self'";
  // Turnstile's widget is a script and a frame from Cloudflare.
  const challenge = turnstileConfigured(env) ? ` ${TURNSTILE_ORIGIN}` : "";
  return {
    "Content-Security-Policy":
      `default-src 'none'; script-src 'self'${challenge}; style-src 'unsafe-inline'; img-src 'self' https:; font-src 'self'; connect-src 'self'; frame-src ${viewer}${challenge}; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  };
}

export default {
  // Cloudflare Email Routing hands support@ mail to the Worker here.
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await receiveEmail(message, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanupAccountObjects(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_flows WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM auth_limits WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM app_codes WHERE expires_at <= ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM username_history WHERE hold_until <= ?").bind(Date.now()),
      // Network hashes are kept 90 days, long enough to spot a returning spammer.
      env.DB.prepare("UPDATE comments SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?").bind(Date.now() - 90 * 86400_000),
      env.DB.prepare("UPDATE versions SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND submitted_at <= ?").bind(Date.now() - 90 * 86400_000),
      env.DB.prepare("UPDATE tickets SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?").bind(Date.now() - 90 * 86400_000),
      env.DB.prepare("UPDATE language_proposals SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?").bind(Date.now() - 90 * 86400_000),
      // An account's last network goes once nothing it posted from there still carries it.
      env.DB.prepare(`UPDATE users SET ip_hash = NULL WHERE ip_hash IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.ip_hash = users.ip_hash)
        AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.ip_hash = users.ip_hash)
        AND NOT EXISTS (SELECT 1 FROM tickets k WHERE k.ip_hash = users.ip_hash)
        AND NOT EXISTS (SELECT 1 FROM language_proposals p WHERE p.ip_hash = users.ip_hash)`),
      env.DB.prepare("DELETE FROM blocklist WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(Date.now()),
      env.DB.prepare("DELETE FROM email_changes WHERE expires_at <= ? OR auth_version != (SELECT auth_version FROM users WHERE id = email_changes.user_id)").bind(Date.now()),
    ]);
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setMainSite(env.MAIN_SITE_URL, supportUrl(env), translationSite(env).href);
    let res: Response;
    const lang = negotiate(req);
    try {
      res = await inLanguage(lang, () => route(req, env, ctx));
    } catch (e) {
      if (e instanceof AuthBusyError) res = inLanguage(lang, () => message(null, false, tp("Sign-in is busy"), tp("Try again shortly."), 503));
      else {
        // Authentication requests can contain bearer secrets. Never log their URLs or bodies.
        console.error("Request failed");
        res = inLanguage(lang, () => message(null, false, tp("Something went wrong"), tp("Try again in a moment."), 500));
      }
    }
    const headers = new Headers(res.headers);
    // Pages follow the language cookie or the browser's languages.
    if ((headers.get("Content-Type") ?? "").startsWith("text/html")) headers.append("Vary", "Cookie, Accept-Language");
    const loopbackForm = headers.has("X-Loopback-Form");
    headers.delete("X-Loopback-Form");
    for (const [k, v] of Object.entries(securityHeaders(env, loopbackForm))) headers.set(k, v);
    if (!headers.has("Set-Cookie")) shareSession(req, env, headers);
    if (new URL(req.url).pathname.startsWith("/auth/") || new URL(req.url).pathname.startsWith("/account") || new URL(req.url).pathname.startsWith("/staff/accounts") || new URL(req.url).pathname === "/login") {
      headers.set("Cache-Control", "no-store");
      headers.set("Referrer-Policy", "strict-origin");
    }
    if (new URL(req.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(res.body, { status: res.status, headers });
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const translationHost = translationSite(env).origin;
  const sharedAsset = ["/logo.png", "/favicon.png", "/site.js"].includes(path) || /^\/fonts\/[a-z-]+\.woff2$/.test(path);
  // Keep account/API routes on the community host; this host serves translations and shared assets.
  if (url.origin === translationHost && translationHost !== new URL(env.SITE_URL).origin && !sharedAsset) {
    if (path === "/hooks/github/" || path === "/hooks/github") return webLateGithubHook(req, env);
    return translateRoute(req, env, await currentUser(req, env));
  }
  // Preserve the initial community URLs as links to the canonical translation site.
  if (method === "GET" && url.origin === new URL(env.SITE_URL).origin && (path === "/translate" || path.startsWith("/translate/")) && translationHost !== url.origin) {
    return Response.redirect(new URL(translationLink(env, path) + url.search, env.SITE_URL).href, 308);
  }
  const avatar = method === 'GET' ? /^\/avatars\/([a-f0-9-]{36})\.png$/.exec(path) : null;
  if (avatar) return profilePicture(env, avatar[1]);
  const account = await localAuth(req, env, ctx);
  if (account) return account;
  // The app's API takes bearer tokens, never the cookie, so it can't be forged from another site.
  if (path.startsWith("/api/")) return api(req, env, path);
  // Forms only come from this site, or the helpdesk's own pages.
  const origin = req.headers.get("Origin");
  if (method === "POST" && origin !== new URL(env.SITE_URL).origin && origin !== new URL(supportUrl(env)).origin) {
    return new Response("Cross-site request refused", { status: 403 });
  }
  if (method === "GET" && path === "/index.json") return indexJson(env);
  let m: RegExpMatchArray | null;
  if (method === "GET" && (m = path.match(/^\/packs\/([0-9a-f]{64})\.json$/))) return packFile(env, m[1]);
  if (method === "GET" && path === "/logo.png") return png(LOGO_PNG);
  if (method === "GET" && path === "/favicon.png") return png(FAVICON_PNG);
  const font = method === "GET" ? /^\/fonts\/([a-z-]+)\.woff2$/.exec(path) : null;
  if (font && Object.hasOwn(FONTS, font[1])) return woff2(FONTS[font[1]]);
  if (method === "GET" && path === "/browse.js") {
    return new Response(BROWSE_JS, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (method === "GET" && path === "/site.js") {
    return new Response(SITE_JS, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }

  const user = await currentUser(req, env);
  const support = supportPath(env, url);
  if (support !== null) return supportRoute(req, env, support, user);
  // The helpdesk's host serves nothing else.
  if (url.host === new URL(supportUrl(env)).host && url.host !== new URL(env.SITE_URL).host) {
    return Response.redirect(`${env.SITE_URL}${path}${url.search}`, 302);
  }
  if (path === "/translate" || path.startsWith("/translate/") || path === "/translate.js") return translateRoute(req, env, user);
  const admin = isAdmin(env, user);
  if (method === "GET" && path === "/") return home(env, user, admin, url.searchParams);
  if (method === "GET" && (m = path.match(/^\/renders\/([0-9a-f]{64})\/([A-Za-z0-9_-]{1,64})\.(dark|light)\.(png|webp)$/))) {
    return renderFile(env, admin, m[1], m[2], m[3], m[4] as "png" | "webp");
  }
  if ((m = path.match(/^\/packs\/([^/]{1,400})(\/source|\/comments)?$/))) {
    let id = "";
    try {
      id = decodeURIComponent(m[1]);
    } catch {}
    if (method === "GET" && !m[2]) return packPage(env, user, admin, id);
    if (method === "GET" && m[2] === "/source") return sourcePage(env, user, admin, id, url.searchParams);
    if (method === "POST" && m[2] === "/comments") {
      if (!user) return new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(`/packs/${id}#comments`)}` } });
      return postComment(req, env, user, admin, id, async (error, draft) => {
        const res = await packPage(env, user, admin, id, error, draft);
        return new Response(res.body, { status: 400, headers: res.headers });
      });
    }
  }
  if (method === 'GET' && (m = path.match(/^\/@([A-Za-z][A-Za-z0-9_]{2,29})$/))) return authorPage(env,user,admin,m[1],true);
  if (method === 'GET' && (m = path.match(/^\/authors\/([A-Za-z0-9_]{1,32})$/))) return authorPage(env,user,admin,m[1]);
  if (method === "POST" && (m = path.match(/^\/comments\/(\d+)\/delete$/))) {
    if (!user) return message(user, admin, tp("Not found"), tp("That comment doesn't exist."), 404);
    return deleteComment(env, user, admin, Number(m[1]));
  }
  if (method === "POST" && (m = path.match(/^\/(comments|packs)\/([^/]{1,400})\/report$/))) {
    if (!user) return new Response(null, { status: 303, headers: { Location: "/login" } });
    let id = "";
    try {
      id = decodeURIComponent(m[2]);
    } catch {}
    const kind = m[1] === "comments" ? "comment" : "pack";
    if (kind === "comment" && !/^\d{1,12}$/.test(id)) return message(user, admin, tp("Not found"), tp("There's nothing here."), 404);
    const result = await report(env, req, user, kind, id, String((await req.formData()).get("reason") ?? ""));
    if ("error" in result) return message(user, admin, tp("Couldn't report that"), result.error, result.status);
    return message(user, admin, tp("Thanks for the report"), tp("We'll take a look. Reports stay private."));
  }
  if (path === "/app/login") {
    if (method === "GET") return appLoginPage(user, url);
    if (method === "POST") return appLoginConfirm(req, env, user);
  }
  if (method === "GET" && path === "/login") return loginPage(user, url.searchParams.get("next") ?? "", env.LOCAL_AUTH_ENABLED === "true");
  if ((m = path.match(/^\/auth\/(\w+)\/(login|callback)$/)) && Object.hasOwn(PROVIDERS, m[1]) && method === "GET") {
    const provider = m[1] as Provider;
    return m[2] === "login" ? login(env, provider, url.searchParams.get("next")) : callback(req, env, provider);
  }
  if (method === "POST" && path === "/auth/logout") return logout(req, env);

  if (path === "/submit" || path === "/me") {
    if (!user) return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(path)}` } });
    if (path === "/me") return myPacks(env, user, admin);
    return method === "POST" ? submit(req, env, user, admin) : submitForm(env, user, admin);
  }

  if (path.startsWith("/admin")) {
    if (!admin || !user) return message(user, admin, tp("Not found"), tp("There's nothing here."), 404);
    if (method === "GET" && path === "/admin") return reviewQueue(env, user, admin);
    if (method === "GET" && path === "/admin/renders") return rendersPage(env, user, admin);
    if (method === "POST" && path === "/admin/renders/redraw") return redraw(env);
    if (method === "POST" && (m = path.match(/^\/admin\/versions\/(\d+)\/redraw$/))) return redraw(env, Number(m[1]));
    if (method === "POST" && (m = path.match(/^\/admin\/versions\/(\d+)\/renders$/))) return saveRenders(req, env, Number(m[1]));
    if ((m = path.match(/^\/admin\/versions\/(\d+)$/))) {
      return method === "POST" ? reviewDecision(req, env, Number(m[1]), user) : reviewPage(env, user, admin, Number(m[1]), url.searchParams);
    }
    if (method === "GET" && (m = path.match(/^\/admin\/versions\/(\d+)\/file$/))) return reviewFile(env, Number(m[1]));
    if (method === "POST" && (m = path.match(/^\/admin\/packs\/([^/]+)$/))) return setListed(req, env, decodeURIComponent(m[1]), user);
    if (method === "POST" && path === "/admin/versions") return bulkVersions(req, env, user);
    if (method === "GET" && path === "/admin/moderation") return moderationPage(env, user);
    if (method === "POST" && path === "/admin/moderation/comments") return bulkComments(req, env, user);
    if (method === "POST" && path === "/admin/moderation/accounts") return bulkAccounts(req, env, user);
    if (method === "POST" && path === "/admin/moderation/settings") return settingsAction(req, env, user);
    if (method === "POST" && path === "/admin/moderation/blocklist") return blocklistAction(req, env, user);
    if (method === "GET" && path === "/admin/moderation/log") return logPage(env, user);
    if (method === "POST" && (m = path.match(/^\/admin\/moderation\/log\/(\d+)\/undo$/))) return undoAction(env, user, Number(m[1]));
    if (method === "POST" && (m = path.match(/^\/admin\/reports\/(\d+)$/))) return reportAction(req, env, user, Number(m[1]));
    if ((m = path.match(/^\/admin\/users\/([^/]+)$/))) {
      let id = "";
      try {
        id = decodeURIComponent(m[1]);
      } catch {}
      return method === "POST" ? userAction(req, env, user, id) : userPage(env, user, id);
    }
  }
  return message(user, admin, tp("Not found"), tp("There's nothing here."), 404);
}

async function indexJson(env: Env): Promise<Response> {
  const packs = (await published(env)).map((v) => ({
    id: v.pack_id,
    name: v.name,
    description: v.description,
    author: v.author,
    version: v.version,
    url: `packs/${v.sha256}.json`,
    sha256: v.sha256,
    blocks: JSON.parse(v.blocks),
    // Blockwork shows a verified badge for these.
    official: v.owner_id === OFFICIAL_OWNER,
    // For the app's filters and sort orders.
    capabilities: JSON.parse(v.capabilities),
    updated: v.submitted_at,
    created: v.pack_created_at,
    comments: v.comments,
  }));
  const body = JSON.stringify({ blockwork_block_index: 1, name: env.LIBRARY_NAME, packs }, null, 2) + "\n";
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}

async function packFile(env: Env, sha: string): Promise<Response> {
  const ok = await env.DB.prepare(
    `SELECT 1 FROM versions v JOIN packs p ON p.id = v.pack_id JOIN users u ON u.id = p.owner_id
     WHERE u.deactivated_at = 0 AND u.deleted_at = 0 AND v.sha256 = ? AND v.status = 'approved' AND p.listed = 1`,
  )
    .bind(sha)
    .first();
  const object = ok ? await env.PACKS.get(`packs/${sha}.json`) : null;
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
}

function woff2(base64: string): Response {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" } });
}

function png(base64: string): Response {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
}

async function submitForm(env: Env, user: User, admin: boolean, error = ""): Promise<Response> {
  return page(tp("Submit a pack"),
    user,
    admin,
    `<h1>Submit a pack</h1>
     ${error ? `<p class="risky">${esc(error)}</p>` : ""}
     <ol><li>In Blockwork, right-click a custom block in the My Blocks palette and pick "Share blocks as a pack...".</li>
     <li>Upload the file here. To update a pack you've shared, upload the new version with the same id.</li></ol>
     <p>Your name goes in front of each block's ID for you, so a block with the ID OpenYouTubeStudio is shared as
     ${esc(idPart(user.name) || "Community")}:OpenYouTubeStudio. IDs can't contain a colon.</p>
     <p>Every pack is reviewed before it's listed. Once it is, anyone can see and download it, along with your account name.
     Packs shouldn't run commands, go online, write files or read secrets unless that's plainly their purpose.</p>
     <form method="post" enctype="multipart/form-data">
       <p><input type="file" name="pack" accept=".blockpack,.json,application/json" required></p>
       ${admin ? "" : await turnstileWidget(env)}
       <p><button class="primary">Submit for review</button></p>
     </form>`,
    error ? 400 : 200,
  );
}

async function submit(req: Request, env: Env, user: User, admin: boolean): Promise<Response> {
  if (user.banned) return submitForm(env, user, admin, "This account can't submit packs.");
  const form = await req.formData();
  if (!admin && !(await passedTurnstile(env, req, form.get("cf-turnstile-response")))) return submitForm(env, user, admin, TURNSTILE_FAILED);
  const file = form.get("pack");
  if (!file || typeof file === "string") return submitForm(env, user, admin, "Pick a pack file to upload.");
  const result = await acceptUpload(env, req, user, new Uint8Array(await file.arrayBuffer()));
  if ("error" in result) return submitForm(env, user, admin, result.error);
  return new Response(null, { status: 303, headers: { Location: "/me" } });
}

async function myPacks(env: Env, user: User, admin: boolean): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT v.*, ? AS author FROM versions v WHERE submitted_by = ? ORDER BY submitted_at DESC LIMIT 100",
  )
    .bind(user.name, user.id)
    .all<VersionRow>();
  await withBlockViews(env, results);
  const label: Record<string, string> = { pending: "Waiting for review", approved: "Listed", rejected: "Not listed" };
  const list = results
    .map((v) =>
      packCard(
        v,
        `<p class="status meta"><span><strong>${esc(label[v.status])}</strong>${v.reason ? `: ${esc(v.reason)}` : ""}</span>
         <span class="muted">submitted ${esc(new Date(v.submitted_at).toISOString().slice(0, 10))}</span></p>`,
      ),
    )
    .join("");
  return page(tp("My packs"), user, admin, `<h1>My packs</h1>${list || `<p class="muted">You haven't submitted any packs.</p>`}`);
}

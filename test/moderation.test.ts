import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/accounts.ts";
import type { User } from "../src/auth.ts";
import { addComment, listComments } from "../src/comments.ts";
import { passedTurnstile, report, rollbackAccount, sameNetwork, screen, undo } from "../src/moderation.ts";
import { receiveEmail, senderCheck } from "../src/support-inbound.ts";

const DAY = 86400_000;

function setup() {
  const f = fixture();
  f.env.ADMINS = "admin:1";
  f.env.SUPPORT_NOTIFY = "staff@example.com";
  const sent: { to: string[]; subject: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("smtp2go")) {
      const body = JSON.parse(String(init?.body));
      sent.push({ to: body.to, subject: body.subject });
      return Response.json({ data: { succeeded: 1 } });
    }
    throw new Error(`Unexpected fetch ${input}`);
  }) as typeof fetch;
  const account = (id: string, ageDays: number, extra = ""): User => {
    f.sql.prepare(`INSERT INTO users (id, name, created_at, public_id) VALUES (?, ?, ?, ?)`).run(id, `Name ${id}`, Date.now() - ageDays * DAY, id.replace(/\W/g, ""));
    if (extra) f.sql.exec(extra);
    return { id, name: `Name ${id}`, avatar: "", banned: 0 };
  };
  const owner = account("owner:1", 100);
  f.sql.prepare("INSERT INTO packs (id, owner_id, created_at) VALUES ('Pack', 'owner:1', 0)").run();
  const from = (ip: string) => new Request("https://community.example.com/x", { headers: { "CF-Connecting-IP": ip } });
  return { ...f, sent, account, owner, from };
}

test("a new account's comment with a link waits for review, and only its writer sees it", async () => {
  const { env, account, from } = setup();
  const fresh = account("new:1", 0);
  const old = account("old:1", 30);
  const held = await addComment(env, from("1.1.1.1"), fresh, false, "Pack", "Free robux at https://spam.example");
  assert.ok("id" in held && held.held);
  const plain = await addComment(env, from("1.1.1.1"), fresh, false, "Pack", "Nice pack, thanks");
  assert.ok("id" in plain && !plain.held);
  const linked = await addComment(env, from("2.2.2.2"), old, false, "Pack", "Docs at https://example.com");
  assert.ok("id" in linked && !linked.held);
  assert.deepEqual((await listComments(env, "Pack")).map((c) => c.body), ["Nice pack, thanks", "Docs at https://example.com"]);
  assert.equal((await listComments(env, "Pack", fresh.id)).length, 3);
});

test("a shadowbanned account's comments look posted to it and to nobody else", async () => {
  const { env, account, from } = setup();
  const quiet = account("shadow:1", 30, "UPDATE users SET shadowbanned = 1 WHERE id = 'shadow:1'");
  const result = await addComment(env, from("3.3.3.3"), quiet, false, "Pack", "Buy my stuff");
  assert.ok("id" in result);
  assert.equal((await listComments(env, "Pack")).length, 0);
  assert.equal((await listComments(env, "Pack", quiet.id)).length, 1);
});

test("lockdown pauses new accounts, or everyone but admins", async () => {
  const { env, sql, account, from } = setup();
  const fresh = account("new:2", 0);
  const old = account("old:2", 30);
  const admin = account("admin:1", 0);
  sql.exec("INSERT INTO moderation_settings (key, value, updated_at) VALUES ('lockdown', 'new', 0)");
  assert.equal((await screen(env, from("4.4.4.4"), fresh, "comment")).ok, false);
  assert.equal((await screen(env, from("4.4.4.4"), old, "comment")).ok, true);
  sql.exec("UPDATE moderation_settings SET value = 'all'");
  assert.equal((await screen(env, from("4.4.4.4"), old, "comment")).ok, false);
  assert.equal((await screen(env, from("4.4.4.4"), admin, "comment")).ok, true);
});

test("one network can't make many accounts do what one account can't", async () => {
  const { env, account, from } = setup();
  let refused = 0;
  for (let i = 0; i < 35; i++) {
    const sock = account(`sock:${i}`, 30);
    if (!(await screen(env, from("5.5.5.5"), sock, "comment")).ok) refused++;
  }
  assert.equal(refused, 5);
  assert.equal((await screen(env, from("6.6.6.6"), account("other:1", 30), "comment")).ok, true);
});

test("a rollback takes down everything an account posted, and one undo puts it back", async () => {
  const { env, sql, account, from } = setup();
  const spammer = account("spam:1", 30);
  const sock = account("spam:2", 30);
  await addComment(env, from("7.7.7.7"), spammer, false, "Pack", "first");
  await addComment(env, from("7.7.7.7"), sock, false, "Pack", "second");
  sql.exec(`INSERT INTO packs (id, owner_id, created_at) VALUES ('Spam', 'spam:1', ${Date.now()});
    INSERT INTO versions (pack_id, sha256, name, description, version, blocks, capabilities, status, submitted_by, submitted_at)
      VALUES ('Spam', 'a', 'Spam', '', '1', '[]', '[]', 'approved', 'spam:1', ${Date.now()}),
             ('Pack', 'b', 'Pack', '', '2', '[]', '[]', 'pending', 'spam:1', ${Date.now()});
    INSERT INTO tickets (subject, status, email, user_id, access_key, created_at, updated_at) VALUES ('x', 'open', 'a@b.c', 'spam:1', 'k', ${Date.now()}, ${Date.now()});
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('t', 'spam:1', ${Date.now() + DAY});`);
  assert.deepEqual((await sameNetwork(env, "spam:1")).map((u) => u.id), ["spam:2"]);

  const done = await rollbackAccount(env, "admin:1", "spam:1", Date.now() - DAY, "ban", true);
  assert.ok(done);
  assert.deepEqual(done.counts, { comments: 1, versions: 2, packs: 1, tickets: 1, languages: 0 });
  assert.deepEqual((await listComments(env, "Pack")).map((c) => c.body), ["second"]);
  const state = () => ({
    versions: sql.prepare("SELECT status FROM versions ORDER BY id").all().map((r) => r.status),
    listed: sql.prepare("SELECT listed FROM packs WHERE id = 'Spam'").get()!.listed,
    ticket: sql.prepare("SELECT status FROM tickets").get()!.status,
    banned: sql.prepare("SELECT banned FROM users WHERE id = 'spam:1'").get()!.banned,
    blocks: sql.prepare("SELECT COUNT(*) AS n FROM blocklist").get()!.n,
  });
  assert.deepEqual(state(), { versions: ["rejected", "rejected"], listed: 0, ticket: "spam", banned: 1, blocks: 1 });
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'spam:1'").get()!.n, 0);
  // The sock on the same network is blocked too, by network.
  assert.equal((await screen(env, from("7.7.7.7"), sock, "comment")).ok, false);

  assert.deepEqual(await undo(env, "admin:1", done.logId), { restored: 7, skipped: 0 });
  assert.deepEqual(state(), { versions: ["approved", "pending"], listed: 1, ticket: "open", banned: 0, blocks: 0 });
  assert.equal((await listComments(env, "Pack")).length, 2);
  assert.equal(await undo(env, "admin:1", done.logId), null);
  assert.equal(await rollbackAccount(env, "admin:1", "admin:1", 0, "ban"), null);
});

test("three reports hold a comment for review", async () => {
  const { env, account, from } = setup();
  const writer = account("writer:1", 30);
  const posted = await addComment(env, from("8.8.8.8"), writer, false, "Pack", "rude");
  assert.ok("id" in posted);
  assert.ok("error" in (await report(env, from("8.8.8.8"), writer, "comment", String(posted.id), "spam")));
  for (let i = 0; i < 3; i++) {
    assert.ok("ok" in (await report(env, from(`9.9.9.${i}`), account(`r:${i}`, 30), "comment", String(posted.id), "spam")));
    assert.equal((await listComments(env, "Pack")).length, i < 2 ? 1 : 0);
  }
});

test("Turnstile is checked when it's set up, and skipped when it isn't", async () => {
  const { env } = setup();
  assert.equal(await passedTurnstile(env, null, undefined), true);
  env.TURNSTILE_SITE_KEY = "site";
  env.TURNSTILE_SECRET = "secret";
  assert.equal(await passedTurnstile(env, null, undefined), false);
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => Response.json({ success: String(init?.body).includes("response=good") })) as typeof fetch;
  assert.equal(await passedTurnstile(env, null, "good"), true);
  assert.equal(await passedTurnstile(env, null, "bad"), false);
});

test("sender checks read the receiving server's SPF, DKIM and DMARC results", () => {
  const h = (v: string | null) => (name: string) => (name === "authentication-results" ? v : null);
  assert.equal(senderCheck(h(null)), "unknown");
  assert.equal(senderCheck(h("mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass")), "verified");
  assert.equal(senderCheck(h("mx.cloudflare.net; dkim=none; spf=softfail; dmarc=none")), "unverified");
  assert.equal(senderCheck(h("mx.cloudflare.net; dkim=fail; spf=pass; dmarc=fail")), "forged");
});

function email(from: string, auth: string | null, subject = "Help") {
  const raw = `From: ${from}\r\nTo: support@blockworked.com\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\n\r\nHello\r\n`;
  const headers = new Headers(auth ? { "Authentication-Results": auth } : {});
  return { from, raw: new Blob([raw]).stream(), rawSize: raw.length, headers, setReject() {} };
}

test("support mail: blocked senders vanish, forged mail lands in spam, unverified mail gets no receipt", async () => {
  const { env, sql, sent } = setup();
  sql.exec("INSERT INTO blocklist (kind, value, created_at) VALUES ('domain', 'spam.example', 0)");
  await receiveEmail(email("bot@spam.example", null), env);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM tickets").get()!.n, 0);

  await receiveEmail(email("ceo@bank.example", "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"), env);
  assert.equal(sql.prepare("SELECT status FROM tickets").get()!.status, "spam");
  assert.equal(sent.length, 0);

  await receiveEmail(email("who@unknown.example", "mx.cloudflare.net; spf=none; dkim=none; dmarc=none"), env);
  assert.deepEqual(sent.map((m) => m.to[0]), ["staff@example.com"]);

  await receiveEmail(email("real@person.example", "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"), env);
  assert.deepEqual(sent.slice(1).map((m) => m.to[0]).sort(), ["real@person.example", "staff@example.com"]);
});

test("the admin pages draw, and their bulk actions log what they did", async () => {
  const { env, sql, account, from } = setup();
  const admin = account("admin:1", 100);
  const spammer = account("spam:9", 0);
  const c = await addComment(env, from("1.2.3.4"), spammer, false, "Pack", "visit https://x.example");
  assert.ok("id" in c);
  sql.exec(`INSERT INTO reports (kind, item_id, reporter_id, reason, created_at) VALUES ('pack', 'Pack', 'admin:1', 'Spam', 0)`);
  const { moderationPage, userPage, logPage, bulkComments, settingsAction, blocklistAction } = await import("../src/moderation-admin.ts");
  const html = async (r: Response | Promise<Response>) => (await r).text();
  assert.match(await html(moderationPage(env, admin)), /Held comments[\s\S]*x\.example/);
  assert.match(await html(userPage(env, admin, "spam:9")), /Roll back/);
  const post = (fields: [string, string][]) => {
    const body = new FormData();
    for (const [k, v] of fields) body.append(k, v);
    return new Request("https://community.example.com/admin", { method: "POST", body });
  };
  await bulkComments(post([["c", String(c.id)], ["action", "remove"]]), env, admin);
  assert.equal(sql.prepare("SELECT removed_at IS NOT NULL AS r FROM comments").get()!.r, 1);
  await settingsAction(post([["lockdown", "new"], ["signups", "closed"]]), env, admin);
  await blocklistAction(post([["kind", "domain"], ["value", "Spam.Example"]]), env, admin);
  assert.equal(sql.prepare("SELECT value FROM blocklist").get()!.value, "spam.example");
  const log = await html(logPage(env, admin));
  for (const action of ["remove-comments", "settings", "block"]) assert.match(log, new RegExp(action));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSubject, isAutomated, isEmail, stripQuoted, ticketFromSubject } from "../src/support-mail.ts";
import { safeNext } from "../src/auth.ts";

test("a reply's ticket number comes from its subject tag", () => {
  assert.equal(ticketFromSubject("Re: [#42] Can't sign in"), 42);
  assert.equal(ticketFromSubject("Can't sign in"), null);
  assert.equal(cleanSubject("RE: Fwd: [#42]  Can't   sign in"), "Can't sign in");
  assert.equal(cleanSubject("   "), "(no subject)");
});

test("only the new part of an emailed reply is kept", () => {
  const gmail = "Thanks, that fixed it!\n\nOn Mon, Nov 2, 2026 at 3:00 AM Blockworked Support <support@blockworked.com> wrote:\n> Try restarting.\n";
  assert.equal(stripQuoted(gmail), "Thanks, that fixed it!");
  const wrapped = "Still broken.\n\nOn Mon, Nov 2, 2026 at 3:00 AM Blockworked Support\n<support@blockworked.com> wrote:\n> Try restarting.";
  assert.equal(stripQuoted(wrapped), "Still broken.");
  const outlook = "Works now.\r\n\r\nFrom: Blockworked Support <support@blockworked.com>\r\nSent: Monday\r\nSubject: Re: [#1] x";
  assert.equal(stripQuoted(outlook), "Works now.");
  assert.equal(stripQuoted("> only a quote"), "> only a quote");
  assert.equal(stripQuoted("Inline:\n> what version?\n2.1\n> anything else?\nNo"), "Inline:\n> what version?\n2.1\n> anything else?\nNo");
});

test("auto-replies never open tickets", () => {
  const h = (map: Record<string, string>) => (name: string) => map[name] ?? null;
  assert.ok(isAutomated(h({ "auto-submitted": "auto-replied" })));
  assert.ok(isAutomated(h({ precedence: "bulk" })));
  assert.ok(isAutomated(h({ "list-id": "<x.example.com>" })));
  assert.ok(!isAutomated(h({ "auto-submitted": "no" })));
  assert.ok(!isAutomated(h({})));
});

test("addresses are checked loosely", () => {
  assert.ok(isEmail("someone@example.com"));
  assert.ok(isEmail("first.last+tag@sub.example.co"));
  for (const bad of ["", "nope", "a@b", "a b@example.com", "<a@example.com>"]) assert.ok(!isEmail(bad), bad);
});

test("sign-in may send you back to the helpdesk, nowhere else", () => {
  const env = { SUPPORT_URL: "https://support.blockworked.com" };
  assert.equal(safeNext("https://support.blockworked.com/new", env), "https://support.blockworked.com/new");
  assert.equal(safeNext("https://evil.example/", env), "/");
  assert.equal(safeNext("https://support.blockworked.com.evil.example/", env), "/");
  assert.equal(safeNext("//evil.example", env), "/");
  assert.equal(safeNext("/me", env), "/me");
  const local = { SUPPORT_URL: "http://localhost:8787/support" };
  assert.equal(safeNext("http://localhost:8787/support/new", local), "http://localhost:8787/support/new");
  assert.equal(safeNext("http://localhost:8787/admin", local), "/");
});

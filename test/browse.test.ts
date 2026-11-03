import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { filterPacks, matchScore, readFilters, type ListedPack } from "../src/browse.ts";
import { checkComment, commentHtml, MAX_COMMENT } from "../src/comments.ts";
import { highlightJson, packSource } from "../src/source.ts";
import { blockPicture, blockPictures, decodePicture } from "../src/renders.ts";

const row = (o: Partial<ListedPack>): ListedPack => ({
  id: 1, pack_id: "p", sha256: "", name: "P", description: "", version: "1", blocks: "[]", capabilities: "[]",
  status: "approved", reason: "", submitted_by: "u", submitted_at: 0, author: "someone", owner_id: "u",
  author_public_id: "x", author_avatar: "", pack_created_at: 0, comments: 0, ...o,
});
const packs = [
  row({ pack_id: "clipboard", name: "Clipboard tools", blocks: '["clean clipboard whitespace"]', capabilities: '["clipboard"]', submitted_at: 3, comments: 1 }),
  row({ pack_id: "net", name: "Web helpers", description: "Fetches café pages", capabilities: '["network"]', submitted_at: 5, pack_created_at: 9 }),
  row({ pack_id: "math", name: "Math", blocks: '["clamp (n)"]', owner_id: "blockwork:team", comments: 4 }),
];
const names = (f: string) => filterPacks(packs, readFilters(new URLSearchParams(f))).map((p) => p.pack_id);

test("filters read from the query string fall back to safe values", () => {
  assert.deepEqual(readFilters(new URLSearchParams("")), { q: "", uses: "", official: false, sort: "name" });
  assert.deepEqual(readFilters(new URLSearchParams("q=x&uses=bogus&sort=bogus&official=1")), { q: "x", uses: "", official: true, sort: "match" });
  assert.equal(readFilters(new URLSearchParams("uses=network")).uses, "network");
});

test("search needs every word, folds case and accents, and ranks names first", () => {
  assert.deepEqual(names("q=clipboard"), ["clipboard"]);
  assert.deepEqual(names("q=CAFE pages"), ["net"]);
  assert.deepEqual(names("q=clamp"), ["math"]);
  assert.deepEqual(names("q=clipboard nothing"), []);
  assert.ok(matchScore(packs[0], "clipboard") > matchScore(packs[0], "whitespace"));
});

test("permission, official and sort filters", () => {
  assert.deepEqual(names(""), ["clipboard", "math", "net"]);
  assert.deepEqual(names("uses=none"), ["math"]);
  assert.deepEqual(names("uses=safe"), ["clipboard", "math"]);
  assert.deepEqual(names("uses=network"), ["net"]);
  assert.deepEqual(names("official=1"), ["math"]);
  assert.deepEqual(names("sort=updated"), ["net", "clipboard", "math"]);
  assert.deepEqual(names("sort=new"), ["net", "clipboard", "math"]);
  assert.deepEqual(names("sort=discussed"), ["math", "clipboard", "net"]);
});

test("every starter pack lists its blocks", () => {
  for (const file of readdirSync("packs").filter((f) => f.endsWith(".json"))) {
    const blocks = packSource(JSON.parse(readFileSync(`packs/${file}`, "utf8")));
    assert.ok(blocks.length > 0, file);
    for (const b of blocks) assert.ok(b.id && b.name && !/undefined|\[object/.test(b.name), `${file}: ${b.name}`);
  }
});

test("block pictures come from the renders, names until then, all escaped", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const sha = "a".repeat(64);
  const names = blockPictures({ sha256: sha, blocks: JSON.stringify([evil]), renders: "" });
  assert.match(names, /<ul class="block-names">/);
  assert.ok(!names.includes("<img"));
  const renders = JSON.stringify({ at: 5, blocks: [{ id: "d1", name: evil, width: 120, height: 31 }] });
  const pictures = blockPictures({ sha256: sha, blocks: "[]", renders });
  assert.ok(pictures.includes(`src="/renders/${sha}/d1.dark.png?at=5" width="120" height="31"`));
  assert.ok(pictures.includes(`/renders/${sha}/d1.light.png?at=5`));
  assert.ok(!pictures.includes("<img src=x"));
  assert.equal(blockPicture({ sha256: sha, renders }, "missing"), "");
  assert.ok(!highlightJson(JSON.stringify({ [evil]: evil })).includes("<img"));
});

test("pictures are PNG or WebP, and WebP ones are linked as such", () => {
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
  assert.equal(decodePicture(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))?.format, "png");
  assert.equal(decodePicture(b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]))?.format, "webp");
  assert.equal(decodePicture(b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), null);
  assert.equal(decodePicture("not base64!"), null);
  const sha = "b".repeat(64);
  const renders = JSON.stringify({ at: 7, blocks: [{ id: "d1", name: "d", width: 10, height: 4, format: "webp" }] });
  assert.ok(blockPictures({ sha256: sha, blocks: "[]", renders }).includes(`/renders/${sha}/d1.dark.webp?at=7`));
});

test("highlighted JSON keeps one line per line", () => {
  const html = highlightJson('{"a":[1,true,null,"x"]}');
  assert.equal(html.split('<span class="ln">').length - 1, JSON.stringify({ a: [1, true, null, "x"] }, null, 2).split("\n").length);
  assert.match(html, /<span class="j-key">&#34;a&#34;<\/span>:/);
  assert.match(html, /<span class="j-lit">true<\/span>/);
});

test("comments are trimmed, limited, escaped, and get links", () => {
  assert.deepEqual(checkComment("  hi\r\n\r\n\r\n\r\nthere  "), { body: "hi\n\nthere" });
  assert.ok("error" in checkComment("   "));
  assert.ok("error" in checkComment("x".repeat(MAX_COMMENT + 1)));
  const html = commentHtml('<b>see https://example.com/a?b=1&c=2. "javascript:alert(1)"</b>');
  assert.ok(!html.includes("<b>"));
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&#38;c=2" rel="nofollow ugc noopener" target="_blank">/);
  assert.ok(!html.includes('href="javascript'));
});

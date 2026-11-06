import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { blockIdentifier, capabilities, readPack, slug, stampPack } from "../src/packs.ts";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const pack = (extra: object = {}) => ({
  blockwork_block_pack: 1,
  id: "my-pack",
  name: "My pack",
  blocks: { block_defs: [{ id: "a", pieces: [{ kind: "Label", text: "say" }, { kind: "Input", name: "text" }] }], strands: [] },
  ...extra,
});

test("seed packs are accepted and match index.json", () => {
  const index = JSON.parse(readFileSync("index.json", "utf8"));
  assert.deepEqual(index.packs.map((p: any) => p.url).sort(),
    readdirSync("packs").filter((f) => f.endsWith(".json")).map((f) => `packs/${f}`).sort());
  for (const file of readdirSync("packs")) {
    const bytes = readFileSync(`packs/${file}`);
    const meta = readPack(bytes);
    assert.equal(typeof meta, "object", `${file}: ${meta}`);
    const entry = index.packs.find((p: any) => p.url === `packs/${file}`);
    assert.equal((meta as any).id, entry.id);
    assert.deepEqual((meta as any).blocks, entry.blocks);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    for (const def of JSON.parse(bytes.toString()).blocks.block_defs) {
      assert.match(def.identifier, /^Blockworked_[A-Za-z0-9]+$/, `${file}: invalid Details ID`);
      assert.ok(def.description.trim(), `${file}: missing description`);
    }
  }
});

test("seed block graphs have unique IDs, bound parameters and declared variables", () => {
  const ids = new Set<string>();
  const claim = (id: string) => {
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.ok(!ids.has(id), `duplicate graph ID: ${id}`);
    ids.add(id);
  };
  for (const file of readdirSync("packs").filter((f) => f.endsWith(".json"))) {
    const content = JSON.parse(readFileSync(`packs/${file}`, "utf8")).blocks;
    const defs = new Map<string, any>(content.block_defs.map((d: any) => [d.id, d]));
    const variables = new Set(content.variables.map((v: any) => v.name));
    assert.equal(content.strands.length, defs.size, `${file}: each block needs a body`);
    const headers = new Set<string>();
    for (const def of defs.values()) {
      claim(def.id);
      def.pieces.forEach((piece: any) => claim(piece.id));
    }
    for (const strand of content.strands) {
      claim(strand.id);
      const header = strand.instructions[0]?.kind?.BlockHeader;
      assert.ok(defs.has(header), `${file}: body has no matching definition`);
      assert.ok(!headers.has(header), `${file}: duplicate body`);
      headers.add(header);
      const params = new Set(defs.get(header).pieces.filter((p: any) => p.kind === "Input").map((p: any) => p.name));
      const walk = (node: any) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        if (node.id) claim(node.id);
        if (node.kind === "Param") assert.ok(params.has(node.name), `${file}: unbound ${node.name}`);
        if (node.kind === "Var") assert.ok(variables.has(node.name), `${file}: undeclared ${node.name}`);
        for (const kind of ["SetVariable", "ChangeVariable"]) {
          if (node.kind?.[kind]) assert.ok(variables.has(node.kind[kind][0]), `${file}: undeclared write`);
        }
        Object.values(node).forEach(walk);
      };
      strand.instructions.forEach(walk);
    }
  }
});

test("block names match the app's", () => {
  const meta = readPack(enc(pack())) as any;
  assert.deepEqual(meta.blocks, ["say (text)"]);
});

test("broken uploads say why", () => {
  assert.match(readPack(new TextEncoder().encode("nope")) as string, /isn't a block pack/);
  assert.match(readPack(enc({ name: "x" })) as string, /isn't a block pack/);
  assert.match(readPack(enc(pack({ blockwork_block_pack: 2 }))) as string, /newer version/);
  assert.match(readPack(enc(pack({ id: "My Pack" }))) as string, /should be "my-pack"/);
  assert.match(readPack(enc(pack({ blocks: { block_defs: [] } }))) as string, /no blocks/);
  assert.match(readPack(new Uint8Array(3 * 1024 * 1024)) as string, /over 2 MB/);
});

test("input defaults accept typed literals and reject expressions or mismatched types", () => {
  const withDefault = (default_value: unknown, value_type = "Any") => enc(pack({
    blocks: { block_defs: [{ id: "a", pieces: [
      { kind: "Label", text: "example" },
      { kind: "Input", name: "input", value_type, default_value },
    ] }], strands: [] },
  }));
  for (const value of [{ kind: "Number", value: 1 }, { kind: "Number", value: 0 },
    { kind: "Text", value: "" }, { kind: "Text", value: "example" }, null]) {
    assert.equal(typeof readPack(withDefault(value)), "object");
  }
  for (const value of [true, false]) {
    assert.equal(typeof readPack(withDefault({ kind: "Bool", value }, "Bool")), "object");
  }
  for (const value of ["example", {}, { kind: "Number", value: "1" },
    { kind: "Bool", value: true }, { kind: "Op", op: "ClipboardText", args: [] }]) {
    assert.match(readPack(withDefault(value)) as string, /literal default/);
  }
  assert.match(readPack(withDefault({ kind: "Number", value: 1 }, "Bool")) as string, /literal default/);
});

test("official packs supply defaults for every input", () => {
  for (const file of readdirSync("packs")) {
    const content = JSON.parse(readFileSync(`packs/${file}`, "utf8")).blocks;
    for (const def of content.block_defs) {
      for (const piece of def.pieces.filter((p: any) => p.kind === "Input")) {
        assert.ok(piece.default_value, `${def.identifier}: missing default for ${piece.name}`);
      }
    }
  }
});

test("slug keeps letters from any script", () => {
  assert.equal(slug("  Hello, World! "), "hello-world");
  assert.equal(slug("Größe 2"), "größe-2");
});

test("capabilities cover instructions, operators and triggers", () => {
  const blocks = {
    strands: [
      {
        instructions: [
          { id: "1", kind: { BlockHeader: "a" } },
          { id: "2", kind: { Command: { kind: "Text", value: "ls" } } },
          { id: "3", kind: { Log: { kind: "Op", op: "Secret", args: [] } } },
          { id: "4", kind: { Repeat: { count: { kind: "Number", value: 2 }, body: [{ id: "5", kind: { PasteText: "x" } }] } } },
          { id: "6", kind: "WhenClipboardChanged" },
          { id: "7", kind: "WhenRan" },
        ],
      },
    ],
  };
  assert.deepEqual(capabilities(blocks), ["commands", "secrets", "input", "clipboard", "triggers"]);
  assert.deepEqual(capabilities({ strands: [{ instructions: [{ id: "1", kind: "WhenRan" }] }] }), []);
});

test("block views keep what drawing a block needs", () => {
  const meta = readPack(enc(pack({
    blocks: {
      block_defs: [
        { id: "a", shape: "ReturnsBool", color: "#59c059", icon: "clipboard", description: "d", pieces: [
          { kind: "Label", text: " is " }, { kind: "Input", name: "x", value_type: "Bool" },
          { kind: "Input", name: "n", component: true, default_value: { kind: "Number", value: 3 } }, { kind: "Label", text: "times" },
          { kind: "Branch", name: "then" }, { kind: "Label", text: "after" },
        ] },
        { id: "b", returns_value: true, color: "red", icon: "Bad Icon", pieces: [{ kind: "Input", name: "t", default_value: { kind: "Text", value: "hi" } }] },
      ],
      strands: [],
    },
  })));
  assert.equal(typeof meta, "object");
  const [a, b] = (meta as any).views;
  assert.equal(a.shape, "ReturnsBool");
  assert.equal(a.color, "#59C059");
  assert.deepEqual(a.pieces, [
    { kind: "Label", text: "is", optional: false },
    { kind: "Input", name: "x", bool: true, optional: false, value: null },
    { kind: "Input", name: "n", bool: false, optional: true, value: "3" },
    { kind: "Label", text: "times", optional: true },
    { kind: "Branch", name: "then" },
    { kind: "Label", text: "after", optional: false },
  ]);
  assert.equal(b.shape, "ReturnsValue");
  assert.equal(b.color, "#4C97FF");
  assert.equal(b.icon, "");
  assert.equal(b.pieces[0].value, "hi");
});

test("block IDs can't contain a colon", () => {
  const defs = [{ id: "a", identifier: "Alice:Open", pieces: [{ kind: "Label", text: "open" }] }];
  assert.match(readPack(enc(pack({ blocks: { block_defs: defs, strands: [] } }))) as string, /"Alice:Open" has a ":"/);
  defs[0].identifier = "Open";
  assert.equal(typeof readPack(enc(pack({ blocks: { block_defs: defs, strands: [] } }))), "object");
});

test("uploads get the uploader's name in front of every block ID", () => {
  const defs = [
    { id: "a", identifier: "OpenYouTubeStudio", pieces: [{ kind: "Label", text: "open studio" }] },
    { id: "b", identifier: "", pieces: [{ kind: "Label", text: "say" }, { kind: "Input", name: "text" }] },
    { id: "c", identifier: "JohnDoe_Old", pieces: [{ kind: "Label", text: "old" }] },
  ];
  const upload = enc(pack({ author: "Someone else", blocks: { block_defs: defs, strands: [] } }));
  const stamped = stampPack(upload, "John Doe");
  assert.ok(stamped instanceof Uint8Array);
  const value = JSON.parse(new TextDecoder().decode(stamped));
  assert.equal(value.author, "John Doe");
  assert.deepEqual(value.blocks.block_defs.map((d: any) => d.identifier), ["JohnDoe:OpenYouTubeStudio", "JohnDoe:saytext", "JohnDoe:Old"]);
  // The stored file is still a pack the library accepts.
  assert.equal(typeof readPack(stamped as Uint8Array, "John Doe"), "object");
  assert.equal(typeof readPack(stamped as Uint8Array, "Jane"), "string");
  assert.equal(typeof readPack(stamped as Uint8Array), "string");
  // Stamping a stamped file changes nothing.
  assert.deepEqual(stampPack(stamped as Uint8Array, "John Doe"), stamped);
  assert.equal(blockIdentifier("", { identifier: "X" }), "Community:X");
});

test("the capability table matches Blockwork's when a checkout sits beside this one", { skip: !existsSync(new URL("../../Blockwork/blockwork-core/capabilities.json", import.meta.url)) }, () => {
  const ours = readFileSync(new URL("../src/capabilities.json", import.meta.url), "utf8");
  const theirs = readFileSync(new URL("../../Blockwork/blockwork-core/capabilities.json", import.meta.url), "utf8");
  assert.equal(ours, theirs, "run node scripts/sync-capabilities.js");
});

test("browser blocks and the waiting command count", () => {
  const blocks = { strands: [{ instructions: [{ id: "1", kind: { BrowserOpen: {} } }, { id: "2", kind: { CommandWait: {} } }] }] };
  assert.deepEqual(capabilities(blocks), ["commands", "browser"]);
});

// Blockwork's slug cases (blockwork-core/tests/fixtures/slugs.json), held to
// this copy of `slug`. CI's blockwork job fetches the checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { slug } from "../src/packs.ts";

const fixture = new URL("../../Blockwork/blockwork-core/tests/fixtures/slugs.json", import.meta.url);

test("slug matches Blockwork's cases when a checkout sits beside this one", { skip: !existsSync(fixture) }, () => {
  for (const [text, expected] of JSON.parse(readFileSync(fixture, "utf8")) as [string, string][]) {
    assert.equal(slug(text), expected, JSON.stringify(text));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/accounts.ts";
import { acceptUpload } from "../src/api.ts";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const pack = (version: string) => enc({
  blockwork_block_pack: 1,
  id: "aim-pack",
  name: "Aim pack",
  version,
  blocks: { block_defs: [{ id: "a", pieces: [{ kind: "Label", text: "aim" }] }], strands: [] },
});

function setup() {
  const f = fixture();
  (f.env as any).PACKS = { put: async () => {} };
  return f;
}

test("a rejected file can be sent again and waits for review", async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO users (id, name, avatar, created_at) VALUES ('u1', 'Ann', '', 0)").run();
  const user = { id: "u1", name: "Ann", avatar: "", banned: 0 } as any;

  const first = await acceptUpload(env, null, user, pack("1.0.1"));
  assert.ok(!("error" in first), JSON.stringify(first));
  assert.deepEqual(await acceptUpload(env, null, user, pack("1.0.1")), { error: "This exact file is already waiting for review." });

  await env.DB.prepare("UPDATE versions SET status = 'rejected', reason = 'Broken block', reviewed_at = 1").run();
  const again = await acceptUpload(env, null, user, pack("1.0.1"));
  assert.ok(!("error" in again), JSON.stringify(again));
  const rows = (await env.DB.prepare("SELECT version, status, reason, reviewed_at FROM versions").all()).results as any[];
  assert.deepEqual(rows.map(r => ({ ...r })), [{ version: "1.0.1", status: "pending", reason: "", reviewed_at: null }]);

  // A changed file with the same version number is a new upload, as before.
  await env.DB.prepare("UPDATE versions SET status = 'approved'").run();
  assert.deepEqual(await acceptUpload(env, null, user, pack("1.0.1")), { error: "This exact file was already approved." });
});

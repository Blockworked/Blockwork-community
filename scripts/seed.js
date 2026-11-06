// Loads the packs in packs/ into the library as approved, owned by the "Blockworked" account.
// Usage: node scripts/seed.js --local | --remote

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_OWNER, readPack, sha256Hex } from "../src/packs.ts";

const where = process.argv[2];
if (where !== "--local" && where !== "--remote") {
  console.error("Usage: node scripts/seed.js --local | --remote");
  process.exit(1);
}
// The database and bucket wrangler.toml binds, so a fork or staging copy seeds its own.
const toml = readFileSync("wrangler.toml", "utf8");
const setting = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? (() => { throw new Error(`wrangler.toml has no ${key}`); })();
const database = setting("database_name");
const bucket = setting("bucket_name");
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();
const owner = OFFICIAL_OWNER;
const sql = [
  `INSERT INTO users (id, name, created_at, public_id) VALUES (${q(owner)}, 'Blockworked', ${now}, 'blockworked') ON CONFLICT (id) DO UPDATE SET name = excluded.name;`,
];
for (const file of readdirSync("packs").filter((f) => f.endsWith(".json"))) {
  const path = join("packs", file);
  const bytes = readFileSync(path);
  const meta = readPack(bytes);
  if (typeof meta === "string") throw new Error(`${file}: ${meta}`);
  const sha = await sha256Hex(bytes);
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/packs/${sha}.json`, "--file", path, "--content-type", "application/json", where], { stdio: "inherit" });
  sql.push(
    `INSERT OR IGNORE INTO packs (id, owner_id, created_at) VALUES (${q(meta.id)}, ${q(owner)}, ${now});`,
    `INSERT OR IGNORE INTO versions (pack_id, sha256, name, description, version, blocks, block_views, capabilities, status, submitted_by, submitted_at, reviewed_at)
     VALUES (${q(meta.id)}, ${q(sha)}, ${q(meta.name)}, ${q(meta.description)}, ${q(meta.version)}, ${q(JSON.stringify(meta.blocks))}, ${q(JSON.stringify(meta.views))}, ${q(JSON.stringify(meta.capabilities))}, 'approved', ${q(owner)}, ${now}, ${now});`,
  );
}
const file = join(mkdtempSync(join(tmpdir(), "blockwork-seed-")), "seed.sql");
writeFileSync(file, sql.join("\n"));
execFileSync("npx", ["wrangler", "d1", "execute", database, "--file", file, where], { stdio: "inherit" });

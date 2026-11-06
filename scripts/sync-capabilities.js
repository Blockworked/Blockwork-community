// Copies Blockwork's capability table into src/, or with --check fails when
// the copy differs. Blockwork's checkout defaults to ../Blockwork.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const blockwork = args.find((a) => !a.startsWith("--")) ?? resolve(import.meta.dirname, "../../Blockwork");
const source = readFileSync(resolve(blockwork, "blockwork-core/capabilities.json"), "utf8");
const target = resolve(import.meta.dirname, "../src/capabilities.json");
if (check) {
  if (readFileSync(target, "utf8") !== source) {
    console.error("src/capabilities.json differs from Blockwork's: run node scripts/sync-capabilities.js");
    process.exit(1);
  }
} else {
  writeFileSync(target, source);
}

// Checks an uploaded block pack and works out what its blocks can do,
// mirroring blockwork-core's read_pack and its capability table.

import capabilityTable from "./capabilities.json" with { type: "json" };

export const MAX_PACK_BYTES = 2 * 1024 * 1024;

/** The account that owns the starter packs. Sign-in ids are "<provider>:<id>", so no one can sign in as it. */
export const OFFICIAL_OWNER = "blockwork:team";

export interface PackMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  blocks: string[];
  /** How each block looks, for drawing it on the site. */
  views: BlockView[];
  capabilities: string[];
}

/** What the site needs to draw a block the way Blockwork's canvas does. */
export interface BlockView {
  shape: "Normal" | "Ending" | "ReturnsValue" | "ReturnsBool";
  color: string;
  icon: string;
  description: string;
  pieces: PieceView[];
}

export type PieceView =
  | { kind: "Label"; text: string; optional: boolean }
  | { kind: "Input"; name: string; bool: boolean; optional: boolean; value: string | null }
  | { kind: "Branch"; name: string };

// Copied from Blockwork's blockwork-core/capabilities.json (run
// `node scripts/sync-capabilities.js`), so the review here matches the app's.
export const CAPABILITIES = capabilityTable.capabilities as [kind: string, label: string, risky: boolean][];
const BLOCKS: Record<string, string[]> = capabilityTable.blocks;
const OPERATORS: Record<string, string> = capabilityTable.operators;

/** Lowercase letters, digits and dashes, like blockwork-core's slug. */
export function slug(text: string): string {
  let out = "";
  // Lowercased a character at a time before the test, as Rust's
  // `char::to_lowercase` does (so "İ" becomes "i" plus a dot that splits).
  for (const c of Array.from(text.trim(), (ch) => ch.toLowerCase()).join("")) {
    if (/[\p{Alphabetic}\p{N}]/u.test(c)) {
      out += c;
    } else if (out && !out.endsWith("-")) {
      out += "-";
    }
  }
  return out.replace(/-+$/, "");
}

export function blockName(def: any): string {
  const words: string[] = [];
  for (const piece of Array.isArray(def?.pieces) ? def.pieces : []) {
    if (piece?.kind === "Label") words.push(String(piece.text ?? "").trim());
    else words.push(`(${String(piece?.name ?? "")})`);
  }
  return words.filter((w) => w).join(" ");
}

const SHAPES = ["Normal", "Ending", "ReturnsValue", "ReturnsBool"] as const;

/** A block definition reduced to what drawing it needs, cleaned like blockstitch's normalize_block_* do. */
export function blockView(def: any): BlockView {
  // Older files have returns_value: bool instead of shape.
  const raw = def?.shape ?? def?.returns_value;
  const shape = raw === true ? "ReturnsValue" : SHAPES.find((s) => s === raw) ?? "Normal";
  const color = typeof def?.color === "string" && /^#[0-9a-f]{6}$/i.test(def.color.trim()) ? def.color.trim().toUpperCase() : "#4C97FF";
  const icon = typeof def?.icon === "string" && /^[a-z0-9-]{1,64}$/.test(def.icon.trim()) ? def.icon.trim() : "";
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const pieces: PieceView[] = [];
  let optional = false;
  for (const piece of Array.isArray(def?.pieces) ? def.pieces : []) {
    if (piece?.kind === "Label") {
      const t = text(piece.text, 200);
      if (t) pieces.push({ kind: "Label", text: t, optional });
    } else if (piece?.kind === "Input") {
      // A component input starts an optional group that runs to the next component or branch.
      if (piece.component) optional = true;
      const d = piece.default_value;
      const value = d && (d.kind === "Text" || d.kind === "Number") ? text(d.value, 120) : null;
      pieces.push({ kind: "Input", name: text(piece.name, 80), bool: piece.value_type === "Bool", optional, value });
    } else if (piece?.kind === "Branch") {
      optional = false;
      pieces.push({ kind: "Branch", name: text(piece.name, 80) });
    }
  }
  return { shape, color, icon, description: text(def?.description, 500), pieces };
}

// The variant name of a serialized InstructionKind: "WhenRan" or {"Token": ...}.
function variant(kind: unknown): string | null {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    const keys = Object.keys(kind);
    if (keys.length === 1) return keys[0];
  }
  return null;
}

/** Everything the pack's blocks can do. Walks the whole document, so it errs towards listing too much. */
export function capabilities(blocks: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.kind === "Op" && typeof obj.op === "string" && OPERATORS[obj.op]) {
      found.add(OPERATORS[obj.op]);
    }
    if ("id" in obj && "kind" in obj) {
      const name = variant(obj.kind);
      if (name) {
        BLOCKS[name]?.forEach((c) => found.add(c));
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(blocks);
  return CAPABILITIES.map(([kind]) => kind).filter((kind) => found.has(kind));
}

/** Parses an upload, or says why it can't be accepted. */
export function readPack(bytes: Uint8Array, username?: string): PackMeta | string {
  if (bytes.byteLength > MAX_PACK_BYTES) return "That file is over 2 MB.";
  let value: any;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return "That isn't a block pack. Make one in Blockwork with \"Share blocks as a pack...\".";
  }
  if (!value || typeof value !== "object" || !("blockwork_block_pack" in value)) {
    return "That isn't a block pack. Make one in Blockwork with \"Share blocks as a pack...\".";
  }
  if (value.blockwork_block_pack !== 1) return "This pack was made by a newer version of Blockwork than the library supports.";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return "The pack has no name.";
  if (name.length > 80) return "The pack's name is over 80 characters.";
  const rawId = typeof value.id === "string" && value.id.trim() ? value.id : name;
  const id = slug(rawId);
  if (!id) return "The pack's id is empty.";
  if (id !== rawId) return `The pack's id should be "${id}". Share it again from Blockwork to fix it.`;
  if (id.length > 64) return "The pack's id is over 64 characters.";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > 500) return "The description is over 500 characters.";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (version.length > 32) return "The version is over 32 characters.";
  const defs = value.blocks?.block_defs;
  if (!Array.isArray(defs) || defs.length === 0) return "The pack has no blocks.";
  if (defs.length > 200) return "The pack has over 200 blocks.";
  if (defs.some((d: any) => typeof d?.id !== "string" || !Array.isArray(d?.pieces))) return "The pack's blocks are broken.";
  if (defs.some((d: any) => d.identifier != null && typeof d.identifier !== "string")) return "The pack's blocks are broken.";
  // A file the library already stamped can come back, but only with this uploader's own name in front.
  const own = username === undefined ? null : `${idPart(username) || "Community"}${ID_SEPARATOR}`;
  const colon = defs.find((d: any) => {
    const id: string = d.identifier ?? "";
    return (own && id.startsWith(own) ? id.slice(own.length) : id).includes(ID_SEPARATOR);
  });
  if (colon) {
    return `Block ID "${colon.identifier}" has a "${ID_SEPARATOR}" in it. The library puts your name in front of each ID for you, so leave it out and share the pack again.`;
  }
  for (const def of defs) {
    for (const piece of def.pieces) {
      if (piece?.kind !== "Input" || piece.default_value == null) continue;
      const value = piece.default_value;
      const valid = piece.value_type === "Bool"
        ? value.kind === "Bool" && typeof value.value === "boolean"
        : (value.kind === "Text" && typeof value.value === "string")
          || (value.kind === "Number" && typeof value.value === "number" && Number.isFinite(value.value));
      if (!valid) return `Input "${piece.name}" needs a literal default matching its type.`;
    }
  }
  return { id, name, description, version, blocks: defs.map(blockName), views: defs.map(blockView), capabilities: capabilities(value.blocks) };
}

/** Separates the uploader's name from a block's own ID, so an uploaded ID can't contain it. */
export const ID_SEPARATOR = ":";

/** Letters and digits only, like blockwork-core's details ids. */
export function idPart(text: string): string {
  return [...text].filter((c) => /[\p{Alphabetic}\p{N}]/u.test(c)).join("");
}

/** A block's Details ID once shared: "<uploader>:<their ID>", the ID falling back to the block's words. */
export function blockIdentifier(username: string, def: any): string {
  const user = idPart(username) || "Community";
  let name = typeof def?.identifier === "string" && def.identifier.trim() ? def.identifier : blockName(def);
  // A re-uploaded file already has "<user>:", and older Blockwork exports put "<author>_" in front themselves.
  if (name.startsWith(`${user}${ID_SEPARATOR}`) || name.startsWith(`${user}_`)) name = name.slice(user.length + 1);
  return `${user}${ID_SEPARATOR}${idPart(name) || "Block"}`;
}

/** The file as the library stores it: the uploader as author, and their name in front of every block ID. Takes a pack readPack accepted. */
export function stampPack(bytes: Uint8Array, username: string): Uint8Array | string {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  value.author = username;
  for (const def of value.blocks.block_defs) def.identifier = blockIdentifier(username, def);
  // Compact when indenting would push it past what Blockwork downloads.
  for (const indent of [2, 0]) {
    const out = new TextEncoder().encode(JSON.stringify(value, null, indent) + "\n");
    if (out.byteLength <= MAX_PACK_BYTES) return out;
  }
  return "That file is over 2 MB.";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

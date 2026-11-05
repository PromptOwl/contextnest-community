/**
 * The seed format with its two side-effect-free dependencies wired in: the
 * YAML loader (JSON schema only — no custom types, no code) and sha256. The
 * rules themselves live in the pure core (core/seed-manifest.ts).
 */
import { createHash } from "crypto";
import yaml from "js-yaml";
import { definitionText, normBody, parseManifestWith, type SeedManifest } from "../core/seed-manifest.js";

export * from "../core/seed-manifest.js";

export function parseManifest(text: string): SeedManifest {
  return parseManifestWith(text, (y) => yaml.load(y, { schema: yaml.JSON_SCHEMA }));
}

/** sha256 of the normalised body (CRLF → LF, trimmed): the `seed_hash`. */
export function seedHash(body: string): string {
  return createHash("sha256").update(normBody(body), "utf8").digest("hex");
}

export function definitionHash(term: string, definition: string): string {
  return createHash("sha256").update(definitionText(term, definition), "utf8").digest("hex");
}

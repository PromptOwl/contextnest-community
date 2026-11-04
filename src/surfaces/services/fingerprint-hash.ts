/**
 * Hold fingerprints for SEALED personal nests keep keyed hashes of the title
 * tokens, never plaintext (re-review R3 INFO). The key is derived from the
 * server's buffer key (never in the database) and scoped per nest, so the
 * tokens can't be read back or correlated across nests from the DB alone.
 * Dedup still works: the judge hashes the new item's tokens the same way.
 */
import { createHmac } from "crypto";
import { guardKey } from "./window-guard-key.js";

export function fingerprintHasher(nestId: string): (token: string) => string {
  const key = guardKey();
  return (t: string) =>
    `h:${key ? createHmac("sha256", key).update(`fp:${nestId}:${t}`).digest("hex").slice(0, 24) : createHmac("sha256", `nokey:${nestId}`).update(t).digest("hex").slice(0, 24)}`;
}

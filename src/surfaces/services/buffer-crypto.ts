/**
 * Buffer encryption (PRD §4.4): AES-256-GCM under the server key
 * SURFACES_BUFFER_KEY (32 bytes, base64 or hex, from the environment — never
 * the database), a fresh 12-byte nonce per row, the tag checked on read.
 *
 * Fail closed: without a valid key nothing is buffered (encryptText throws,
 * and the ingest path treats that as "drop").
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "../../config.js";

export class BufferKeyError extends Error {}

export function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new BufferKeyError("SURFACES_BUFFER_KEY is not set");
  const t = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (buf.length !== 32) throw new BufferKeyError("SURFACES_BUFFER_KEY must be 32 bytes (base64 or hex)");
  return buf;
}

export function bufferKey(): Buffer {
  return parseKey(config.SURFACES_BUFFER_KEY);
}

export function bufferKeyConfigured(): boolean {
  try {
    bufferKey();
    return true;
  } catch {
    return false;
  }
}

/** ciphertext||tag and nonce, both base64. */
export function encryptText(text: string, key: Buffer = bufferKey()): { enc: string; nonce: string } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { enc: Buffer.concat([ct, c.getAuthTag()]).toString("base64"), nonce: nonce.toString("base64") };
}

export function decryptText(enc: string, nonce: string, key: Buffer = bufferKey()): string {
  const raw = Buffer.from(enc, "base64");
  if (raw.length < 16) throw new Error("buffer row is malformed");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString("utf8");
}

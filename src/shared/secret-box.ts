/**
 * Encryption at rest for the credentials this server stores — the Anthropic
 * key, the OIDC client secret, SMTP and webhook URLs, a nest's Tool
 * environment.
 *
 * Why: those values used to sit in the database in the clear, so anything
 * that so much as read a row read the credential — a log line, a support
 * export, a `SELECT *` in a console, a replica of one table. Now the stored
 * form is opaque: AES-256-GCM, a fresh 12-byte IV per value, tag verified on
 * read, written as `enc.v1.<iv>.<tag>.<ciphertext>` in base64url.
 *
 * Self-describing on purpose: a value written before this module existed
 * doesn't carry the prefix, is read back as plaintext, and re-encrypts the
 * next time it is saved. Nothing to migrate.
 *
 * The master key, in order:
 *   1. `SECRETS_KEY` from the deploy environment. The strongest form — the
 *      key lives somewhere the database is not, so a database dump alone is
 *      useless. Use it where the deployment has a secret manager.
 *   2. otherwise a 32-byte key generated once into the database itself and
 *      reused forever after. Survives redeploys and is shared by every
 *      instance with nothing to configure, which is why it is the default.
 *      The honest limit: a dump that includes this row includes the key, so
 *      what this protects against is incidental exposure of a value, not an
 *      attacker who has the whole database.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";

const PREFIX = "enc.v1.";
const b64 = (b: Buffer) => b.toString("base64url");

/**
 * Where the generated key lives. A server_settings row so it needs no
 * migration, and NOT one of the settings: loadServerSettings skips it, so it
 * never reaches process.env and never appears in the settings API.
 */
export const MASTER_KEY_SETTING = "SECRETS_MASTER_KEY";

/**
 * Server settings whose value is a credential. Everything else (a gate, a
 * URL, a feature flag) stays readable in the database, where being able to
 * see what a server is configured to do is a feature.
 */
const SECRET_SETTINGS = new Set([
  "ANTHROPIC_API_KEY",
  "OIDC_CLIENT_SECRET",
  "MCP_SIGNING_SECRET",
  "SMTP_URL",
  "SLACK_WEBHOOK_URL",
  "MSTEAMS_WEBHOOK_URL",
  "PROMPTOWL_KEY",
]);

export function isSecretSetting(name: string): boolean {
  return SECRET_SETTINGS.has(name);
}

/** Already in the stored ciphertext form? */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Wrap a value for storage. Encrypting an encrypted value is a no-op. */
export async function encryptSecret(plain: string): Promise<string> {
  if (isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + [b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

/**
 * Unwrap a stored value. A value that was never encrypted comes back
 * unchanged — that is how rows written before this module keep working.
 *
 * @throws when the value IS ciphertext but this key can't open it (a
 * SECRETS_KEY set to something else, or a tampered row). Callers decide what
 * to do; one unreadable credential must not take the server down.
 */
export async function decryptSecret(stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(".");
  if (!iv || !tag || !ct) throw new Error("malformed encrypted value");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await masterKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Best-effort read for the paths where one unreadable credential must not
 * stop the rest: boot, and the masked listings. Returns null when the value
 * can't be opened, and says which setting so the admin knows what to re-enter.
 */
export async function tryDecryptSecret(
  stored: string,
  label: string,
): Promise<string | null> {
  try {
    return await decryptSecret(stored);
  } catch {
    console.error(
      `[secrets] cannot decrypt ${label} — SECRETS_KEY does not match the key this value was written with. Unset it to fall back to the stored key, or re-enter the value to replace it.`,
    );
    return null;
  }
}

/**
 * The master key. Cached per SECRETS_KEY value rather than outright: it is
 * read from the environment, and the test suite varies it. The generated-key
 * branch is cached per database, since each test suite gets its own.
 */
let cached: { id: string; key: Buffer } | null = null;
let inFlight: Promise<Buffer> | null = null;

async function masterKey(): Promise<Buffer> {
  const fromEnv = (process.env.SECRETS_KEY || "").trim();
  if (fromEnv) {
    // Hashed, not used raw: SECRETS_KEY is whatever the operator typed, and
    // AES-256 needs exactly 32 bytes.
    if (cached?.id !== fromEnv) {
      cached = { id: fromEnv, key: createHash("sha256").update(fromEnv).digest() };
    }
    return cached.key;
  }
  const db = getDb();
  const id = `db:${db.dialect}:${dbIdentity(db)}`;
  if (cached?.id === id) return cached.key;
  // One read/insert at a time per process: the first caller's lookup is what
  // every concurrent caller waits on, so a cold start doesn't race itself.
  if (!inFlight) inFlight = loadOrCreateKey(id).finally(() => (inFlight = null));
  return inFlight;
}

async function loadOrCreateKey(id: string): Promise<Buffer> {
  const db = getDb();
  const read = async () =>
    (await db.get("SELECT value FROM server_settings WHERE key = ?", [
      MASTER_KEY_SETTING,
    ])) as { value: string | null } | undefined;

  let row = await read();
  if (!row?.value) {
    // DO NOTHING, not REPLACE: two instances booting together must end up on
    // the same key — whoever lost the race reads the winner's row back.
    const sql =
      db.dialect === "sqlite"
        ? `INSERT OR IGNORE INTO server_settings (key, value, env_at_write, updated_at)
           VALUES (?, ?, NULL, ${nowExpr(db)})`
        : `INSERT INTO server_settings (key, value, env_at_write, updated_at)
           VALUES (?, ?, NULL, ${nowExpr(db)}) ON CONFLICT (key) DO NOTHING`;
    await db.run(sql, [MASTER_KEY_SETTING, randomBytes(32).toString("hex")]);
    row = await read();
  }
  if (!row?.value) throw new Error("could not establish an encryption key");
  const key = Buffer.from(row.value, "hex");
  cached = { id, key };
  return key;
}

/** Enough to tell one test suite's database from the next. */
function dbIdentity(db: { dialect: string }): string {
  return process.env.DATABASE_URL || process.env.DATA_ROOT || db.dialect;
}

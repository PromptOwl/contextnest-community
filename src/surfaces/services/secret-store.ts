/**
 * Install secrets (bot token, client id/secret, signing secret): encrypted at
 * rest with the server's secret box, readable by server code only. No route
 * or MCP tool returns a value — reads report which names are set (AC-INS-02).
 *
 * Not the nest env store on purpose (VERIFY V10): env values leave the server
 * in every run bundle and GET shows a masked tail; a Slack bot token must do
 * neither.
 */
import { getDb } from "../../db/client.js";
import { encryptSecret, tryDecryptSecret } from "../../shared/secret-box.js";

export type SecretName = "client_id" | "client_secret" | "signing_secret" | "bot_token";
export const SECRET_NAMES: readonly SecretName[] = ["client_id", "client_secret", "signing_secret", "bot_token"];

export async function setSecret(installId: string, name: SecretName, value: string, by: string | null): Promise<void> {
  const enc = await encryptSecret(value);
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO surface_secrets (install_id, name, value_enc, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (install_id, name) DO UPDATE SET value_enc = excluded.value_enc, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [installId, name, enc, by, now, now],
  );
}

/** Server-side read. null when unset or unopenable (fail closed). */
export async function getSecret(installId: string, name: SecretName): Promise<string | null> {
  const row = (await getDb().get("SELECT value_enc FROM surface_secrets WHERE install_id = ? AND name = ?", [installId, name])) as
    | { value_enc: string }
    | undefined;
  if (!row) return null;
  return (await tryDecryptSecret(row.value_enc, `surfaces ${name}`)) ?? null;
}

/** Which secrets are set — booleans only, for views. */
export async function secretPresence(installId: string): Promise<Record<SecretName, boolean>> {
  const rows = (await getDb().all("SELECT name FROM surface_secrets WHERE install_id = ?", [installId])) as Array<{ name: string }>;
  const have = new Set(rows.map((r) => r.name));
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, have.has(n)])) as Record<SecretName, boolean>;
}

export async function deleteSecrets(installId: string): Promise<number> {
  return (await getDb().run("DELETE FROM surface_secrets WHERE install_id = ?", [installId])).changes;
}

/**
 * surface_installs persistence. Creating an install over REST (manifest /
 * OAuth) is S2a; S1 needs the row so bindings and identity links hang off it.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { ORG_ID } from "../flags.js";
import type { Surface, SurfaceInstallRef } from "../contract.js";

export interface InstallRow {
  id: string;
  org_id: string;
  surface: Surface;
  mode: "manifest" | "hosted" | "selfhosted";
  tenant_key: string;
  team_id: string | null;
  enterprise_id: string | null;
  bot_user_id: string | null;
  home_nest_id: string | null;
  installed_by_user_id: string | null;
  status: "pending" | "active" | "revoked" | "disconnected";
}

export async function createInstall(input: {
  surface: Surface;
  mode: InstallRow["mode"];
  tenantKey: string;
  teamId?: string | null;
  enterpriseId?: string | null;
  botUserId?: string | null;
  homeNestId?: string | null;
  installedByUserId?: string | null;
  status?: InstallRow["status"];
}): Promise<InstallRow> {
  const id = uuid();
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO surface_installs (id, org_id, surface, mode, tenant_key, team_id, enterprise_id, bot_user_id, home_nest_id,
       installed_by_user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ORG_ID,
      input.surface,
      input.mode,
      input.tenantKey,
      input.teamId ?? null,
      input.enterpriseId ?? null,
      input.botUserId ?? null,
      input.homeNestId ?? null,
      input.installedByUserId ?? null,
      input.status ?? "pending",
      now,
      now,
    ],
  );
  return (await getInstall(id))!;
}

export async function getInstall(id: string): Promise<InstallRow | null> {
  return ((await getDb().get("SELECT * FROM surface_installs WHERE id = ?", [id])) as InstallRow | undefined) ?? null;
}

export async function listInstalls(): Promise<InstallRow[]> {
  return (await getDb().all("SELECT * FROM surface_installs ORDER BY created_at")) as InstallRow[];
}

export function installRef(row: InstallRow): SurfaceInstallRef {
  return {
    id: row.id,
    surface: row.surface,
    tenant_key: row.tenant_key,
    team_id: row.team_id,
    enterprise_id: row.enterprise_id,
    bot_user_id: row.bot_user_id,
  };
}

/** The install's home team (Slack team / Teams tenant). */
export function homeTenant(row: Pick<InstallRow, "team_id" | "tenant_key">): string {
  return row.team_id ?? row.tenant_key;
}

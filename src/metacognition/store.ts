/**
 * metacognition_agents rows and the persona identity behind each.
 *
 * A persona is a SERVICE identity (users.is_service = 1), the same kind of
 * account an access key gets: no usable password, no API key, never listed as
 * a person, and an `.invalid` address (RFC 2606) so nothing can sign in or be
 * emailed as it. It exists so that what the agent does — proposals, comments,
 * review requests — is attributed to a name people recognise, not to whoever
 * configured it. Nothing can authenticate as it: the server acts as the
 * persona only inside a run.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { safeJson } from "../shared/json.js";
import type { MetacognitionConfig } from "./config.js";

export const SERVER_CLAIM = "server:metacognition";

export interface MetacognitionAgent {
  nest_id: string;
  node_id: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  persona: { user_id: string; email: string; name: string; avatar: string | null };
  config: MetacognitionConfig;
}

interface Row {
  nest_id: string;
  node_id: string;
  persona_user_id: string;
  config_json: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  persona_email: string | null;
  persona_name: string | null;
}

const SELECT = `SELECT m.*, u.email AS persona_email, u.name AS persona_name
                  FROM metacognition_agents m
                  LEFT JOIN users u ON u.id = m.persona_user_id`;

function toAgent(r: Row): MetacognitionAgent {
  const config = (safeJson(r.config_json) ?? {}) as MetacognitionConfig;
  return {
    nest_id: r.nest_id,
    node_id: r.node_id,
    enabled: !!r.enabled,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    persona: {
      user_id: r.persona_user_id,
      email: r.persona_email ?? "",
      name: r.persona_name ?? config.persona?.name ?? "Agent",
      avatar: config.persona?.avatar ?? null,
    },
    config,
  };
}

export async function getAgent(nestId: string, nodeId: string): Promise<MetacognitionAgent | null> {
  const row = (await getDb().get(`${SELECT} WHERE m.nest_id = ? AND m.node_id = ?`, [nestId, nodeId])) as
    | Row
    | undefined;
  return row ? toAgent(row) : null;
}

export async function listAgents(nestId: string): Promise<MetacognitionAgent[]> {
  const rows = (await getDb().all(`${SELECT} WHERE m.nest_id = ? ORDER BY m.node_id`, [nestId])) as Row[];
  return rows.map(toAgent);
}

/** Node ids of the nest's enabled agents — what the server, not a runner, runs. */
export async function serverRunNodeIds(nestId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    "SELECT node_id FROM metacognition_agents WHERE nest_id = ? AND enabled = 1",
    [nestId],
  )) as Array<{ node_id: string }>;
  return new Set(rows.map((r) => r.node_id));
}

/**
 * Save an agent. The OWNER (`created_by`) is pinned at creation: saving the
 * settings later — even as a server admin — does not make the saver the
 * owner. It used to, and since the run gate checks the owner, an admin
 * tweaking a cap silently became the person the agent answered to.
 *
 * The one exception is an owner who can no longer stand behind the agent
 * (`ownerUsable` false: gone, or lost write on the nest). Then the agent
 * cannot run at all, and the admin saving it takes it over — reported back
 * as `ownerChanged` so the UI can say so.
 *
 * Ownership never widens what the persona can do: its reach is its own
 * scope and grants (tools.ts), never its owner's role.
 */
export async function upsertAgent(input: {
  nestId: string;
  nodeId: string;
  config: MetacognitionConfig;
  enabled: boolean;
  savedBy: string;
  /** Can the current owner still run this agent? Only asked on an update. */
  ownerUsable?: (ownerEmail: string) => Promise<boolean>;
}): Promise<MetacognitionAgent & { ownerChanged: boolean }> {
  const db = getDb();
  const existing = await getAgent(input.nestId, input.nodeId);
  const now = new Date().toISOString();
  const json = JSON.stringify(input.config);
  let ownerChanged = false;
  if (existing) {
    const keep = input.ownerUsable ? await input.ownerUsable(existing.created_by) : true;
    const owner = keep ? existing.created_by : input.savedBy;
    ownerChanged = owner.toLowerCase() !== existing.created_by.toLowerCase();
    await db.transaction(async (tx) => {
      await tx.run("UPDATE users SET name = ? WHERE id = ? AND is_service = 1", [
        input.config.persona.name,
        existing.persona.user_id,
      ]);
      await tx.run(
        `UPDATE metacognition_agents SET config_json = ?, enabled = ?, created_by = ?, updated_at = ?
          WHERE nest_id = ? AND node_id = ?`,
        [json, input.enabled ? 1 : 0, owner, now, input.nestId, input.nodeId],
      );
    });
  } else {
    const personaId = uuid();
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO users (id, email, name, password_hash, is_service) VALUES (?, ?, ?, ?, 1)",
        [personaId, `persona-${personaId}@agents.invalid`, input.config.persona.name, "!"],
      );
      await tx.run(
        `INSERT INTO metacognition_agents (nest_id, node_id, persona_user_id, config_json, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.nestId, input.nodeId, personaId, json, input.enabled ? 1 : 0, input.savedBy, now, now],
      );
    });
  }
  return { ...(await getAgent(input.nestId, input.nodeId))!, ownerChanged };
}

/** Is this user a metacognition persona (as opposed to an access key's
 *  service identity)? Returns the nests it lives in — its only home. */
export async function personaHomeNests(userId: string): Promise<string[]> {
  const rows = (await getDb().all(
    "SELECT DISTINCT nest_id FROM metacognition_agents WHERE persona_user_id = ?",
    [userId],
  )) as Array<{ nest_id: string }>;
  return rows.map((r) => r.nest_id);
}

/** Remove the agent. The persona identity stays: it authored versions and
 *  review requests whose history must keep resolving to a name. */
export async function deleteAgent(nestId: string, nodeId: string): Promise<boolean> {
  const res = await getDb().run("DELETE FROM metacognition_agents WHERE nest_id = ? AND node_id = ?", [
    nestId,
    nodeId,
  ]);
  return res.changes > 0;
}

/** Is the run row one the server claimed for a metacognition agent? */
export function isServerRun(run: { claimed_by?: string | null }): boolean {
  return run.claimed_by === SERVER_CLAIM;
}

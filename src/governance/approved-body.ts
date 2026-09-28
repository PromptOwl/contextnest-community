/**
 * The approved version's raw bytes, healing a pin that can no longer be rebuilt.
 *
 * An older import could overwrite part of a node's saved history, leaving the
 * approved version unreconstructable while a newer published version is still
 * intact. On the read that hits it, the pin moves to the newest published
 * version that rebuilds and the move is noted on that version's history row.
 * No version is created and the engine's saved history is never touched; a
 * draft or pending version is never promoted. (CU-wdqcq02vet)
 */
import { getDb } from "../db/client.js";
import { getApprovedVersion } from "./version-service.js";

interface Reconstructs {
  reconstructVersion(nodeId: string, version: number): Promise<string>;
}

export async function reconstructApproved(
  versionManager: Reconstructs,
  nestId: string,
  nodeId: string,
  approved: number,
): Promise<{ raw: string; version: number }> {
  try {
    return { raw: await versionManager.reconstructVersion(nodeId, approved), version: approved };
  } catch (err) {
    // Another read may have healed this node already — use its pin.
    const current = await getApprovedVersion(nestId, nodeId);
    if (current != null && current !== approved) {
      return { raw: await versionManager.reconstructVersion(nodeId, current), version: current };
    }
    const db = getDb();
    const newer = (await db.all(
      `SELECT version FROM node_versions
        WHERE nest_id = ? AND node_id = ? AND version > ? AND status IN ('published', 'approved')
        ORDER BY version DESC`,
      [nestId, nodeId, approved],
    )) as Array<{ version: number }>;
    for (const { version } of newer) {
      let raw: string;
      try {
        raw = await versionManager.reconstructVersion(nodeId, version);
      } catch {
        continue;
      }
      // Conditional on the old pin, so concurrent reads record the move once.
      const moved = await db.run(
        `UPDATE approved_versions SET approved_version = ?
          WHERE nest_id = ? AND node_id = ? AND approved_version = ?`,
        [version, nestId, nodeId, approved],
      );
      if (moved.changes > 0) {
        const note = `Approved version moved from v${approved} to v${version} — v${approved} could not be rebuilt`;
        await db.run(
          `UPDATE node_versions
              SET change_note = CASE WHEN change_note IS NULL OR change_note = '' THEN ? ELSE change_note || ' · ' || ? END
            WHERE nest_id = ? AND node_id = ? AND version = ?`,
          [note, note, nestId, nodeId, version],
        );
        console.warn(`[approved-heal] ${nestId}/${nodeId}: ${note}`);
      }
      return { raw, version };
    }
    console.error(`[approved-heal] ${nestId}/${nodeId}: v${approved} can't be rebuilt and no newer published version can`, err);
    throw err;
  }
}

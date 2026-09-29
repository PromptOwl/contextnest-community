/**
 * The approved version's raw bytes, healing a pin that can no longer be rebuilt.
 *
 * An older import could overwrite part of a node's saved history, leaving the
 * approved version unreconstructable while a newer published version is still
 * intact. On the read that hits it, the pin moves to the newest published
 * version that rebuilds, credited to the server (not the original reviewer),
 * and the move is noted on that version's history row. No version is created,
 * the engine's saved history is never touched, and a draft or pending version
 * is never promoted. (CU-wdqcq02vet)
 */
import { getApprovedVersion, getVersions, moveApprovedVersion } from "./version-service.js";

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
    // Newest first; only versions that were already published.
    const newer = (await getVersions(nestId, nodeId)).filter(
      (v) => v.version > approved && (v.status === "published" || v.status === "approved"),
    );
    for (const { version } of newer) {
      let raw: string;
      try {
        raw = await versionManager.reconstructVersion(nodeId, version);
      } catch {
        continue;
      }
      if (await moveApprovedVersion(nestId, nodeId, approved, version)) {
        console.warn(`[approved-heal] ${nestId}/${nodeId}: approved v${approved} → v${version} (v${approved} could not be rebuilt)`);
      }
      return { raw, version };
    }
    console.error(`[approved-heal] ${nestId}/${nodeId}: v${approved} can't be rebuilt and no newer published version can`, err);
    throw err;
  }
}

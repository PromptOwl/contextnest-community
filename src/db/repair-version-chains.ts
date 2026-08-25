/**
 * One-shot repair: re-anchor documents whose engine version chain was grafted.
 *
 * Version numbers used to be derived from a document's frontmatter (publish) or
 * its node_versions rows (draft save), never from history.yaml itself. When
 * either source lagged the on-disk chain — a nest imported with its `.versions/`
 * folder copied along, a DB mirror that failed after the engine append — the
 * next save reused a live version number and grafted a SECOND chain onto the
 * first. `history.yaml` then holds duplicate versions, `v{N}.md` keyframes were
 * overwritten at the same number, and reconstruction dies from the graft point
 * on: the version panel shows "(no content)" and approved-only reads (public
 * readers, /export, MCP) return an empty body.
 *
 * Numbering is fixed at the source now (engine `nextVersion`), so no NEW graft
 * can form. Documents already grafted stay unreadable until touched, which is
 * what this pass fixes: the engine re-anchors each broken document's latest
 * version onto its live bytes. Nothing is renumbered and no version is added —
 * only versions from before the graft stay unreadable, and those bytes are gone.
 *
 * Gated via schema_migrations so it doesn't repeat on restart.
 */

import { VersionManager } from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import type { DatabaseAdapter } from "./adapter.js";
import { insertOrIgnore } from "./sql.js";

const MIGRATION_ID = "010_repair_grafted_version_chains";

export async function repairGraftedVersionChains(
  db: DatabaseAdapter,
): Promise<void> {
  const already = await db.get("SELECT id FROM schema_migrations WHERE id = ?", [
    MIGRATION_ID,
  ]);
  if (already) return;

  const nests = (await db.all("SELECT id FROM nests")) as { id: string }[];
  let scanned = 0;
  let repaired = 0;
  let externalized = 0;

  for (const { id: nestId } of nests) {
    let storage;
    let versions: VersionManager;
    try {
      ({ storage, versions } = await engineCache.get(nestId));
    } catch (err) {
      console.warn(
        `[repair] engine unavailable for nest ${nestId}:`,
        (err as Error).message,
      );
      continue;
    }

    let docs;
    try {
      docs = await storage.discoverDocuments();
    } catch (err) {
      console.warn(
        `[repair] discoverDocuments failed for nest ${nestId}:`,
        (err as Error).message,
      );
      continue;
    }

    for (const doc of docs) {
      scanned += 1;
      try {
        if (await versions.repairLatestVersion(doc.id)) {
          repaired += 1;
          console.log(`[repair] re-anchored version chain: ${nestId}/${doc.id}`);
        }
        // Move any patches still stored inline in history.yaml out into their
        // own v{N}.diff change-log files. Reads work either way, so this only
        // brings older versions up to the current layout — and shrinks a
        // history.yaml that is rewritten whole on every edit.
        externalized += await versions.externalizeDiffs(doc.id);
      } catch (err) {
        // A doc we can't repair must not stop the pass — the rest still get fixed.
        console.warn(
          `[repair] could not repair ${nestId}/${doc.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  await db.run(insertOrIgnore(db, "INSERT INTO schema_migrations (id) VALUES (?)"), [
    MIGRATION_ID,
  ]);

  console.log(
    `[repair] version chains: scanned ${scanned} docs across ${nests.length} nests, ` +
      `re-anchored ${repaired}, externalized ${externalized} inline change log(s)`,
  );
}

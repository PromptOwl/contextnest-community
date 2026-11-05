import { readdir } from "fs/promises";
import type { Dirent } from "fs";
import { join, relative, sep } from "path";
import { NestStorage } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { isSkippedSegment } from "../fs/vault-import.js";
import { isMetaFile } from "./meta-files.js";
import { mapBatched } from "../shared/batch.js";


/**
 * NestStorage variant for imported folders.
 *
 * The base engine only scans `nodes/**` once a `nodes/` directory exists
 * (structured layout). A user's existing vault usually keeps documents at
 * the root or in topic folders (engineering/, onboarding/, …), so structured
 * discovery would miss them. This subclass discovers every real markdown
 * document anywhere under the folder, skipping hidden directories
 * (.versions, .context, .obsidian, .git), node_modules, and the meta files
 * above. Read/write/version operations are inherited unchanged — they key
 * off the document id (its path relative to the root), which this discovery
 * produces.
 */
export class FlatNestStorage extends NestStorage {
  async discoverDocuments(): Promise<ContextNode[]> {
    const root = this.root;
    const ids: string[] = [];
    // Async walk that prunes hidden dirs / node_modules BEFORE entering them: a
    // recursive readdir also crawled .versions/, where the write lock folder
    // (.versions/.lock) comes and goes, and one vanished dir failed the listing.
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err: any) {
        if (dir !== root && err?.code === "ENOENT") return; // removed mid-walk
        throw err;
      }
      await Promise.all(entries.map(async (e) => {
        if (isSkippedSegment(e.name)) return;
        const full = join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        // Engine- and agent-generated files ride along on import but are not
        // documents (isMetaFile).
        if (!e.isFile() || !e.name.endsWith(".md") || isMetaFile(e.name)) return;
        ids.push(relative(root, full).split(sep).join("/").replace(/\.md$/, ""));
      }));
    };
    try {
      await walk(root);
    } catch (err) {
      console.error("[FlatNestStorage] cannot read folder", root, err);
      return [];
    }

    // Read in bounded-parallel batches: on a Cloud Storage mount every read is
    // a network round trip, so one document at a time cost one latency each —
    // and an import runs this crawl several times over. mapBatched preserves
    // input order, so the result stays sorted by id.
    ids.sort();
    const read = await mapBatched(ids, async (id) => {
      try {
        return await this.readDocument(id);
      } catch (err) {
        // Unreadable / malformed markdown — skip rather than fail the list,
        // but log so a silently-dropped doc is traceable.
        console.error("[FlatNestStorage] skipped unreadable doc", id, err);
        return null;
      }
    });
    return read.filter((n): n is ContextNode => n !== null);
  }
}

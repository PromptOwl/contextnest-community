import { readdirSync, type Dirent } from "fs";
import { join, relative, sep } from "path";
import { NestStorage } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { isSkippedSegment } from "../fs/vault-import.js";

// Engine- and agent-generated files that live alongside documents but are
// NOT themselves documents. The engine excludes these in structured mode;
// we replicate that for flat discovery so an imported vault doesn't surface
// its CLAUDE.md / INDEX.md / CONTEXT.md as editable nodes.
const META_FILES = new Set([
  "INDEX.md",
  "CONTEXT.md",
  "CLAUDE.md",
  "GEMINI.md",
  "AGENTS.md",
  "QWEN.md",
]);

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
/** Documents read per parallel batch — see discoverDocuments. */
const READ_CONCURRENCY = 32;

export class FlatNestStorage extends NestStorage {
  async discoverDocuments(): Promise<ContextNode[]> {
    const root = this.root;
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { recursive: true, withFileTypes: true });
    } catch (err) {
      console.error("[FlatNestStorage] cannot read folder", root, err);
      return [];
    }

    const ids: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      if (META_FILES.has(e.name)) continue;
      // Dirent.parentPath (Node ≥20.12); `path` is the older alias.
      const dir = (e as any).parentPath ?? (e as any).path ?? root;
      const rel = relative(root, join(dir, e.name)).split(sep).join("/");
      // Skip anything inside a hidden dir or node_modules.
      if (rel.split("/").some(isSkippedSegment)) continue;
      ids.push(rel.replace(/\.md$/, ""));
    }

    // Read in bounded-parallel batches. On a Cloud Storage mount every read is
    // a network round trip, so reading one document at a time cost one latency
    // per document — and an import runs this crawl several times over. Ordering
    // is preserved by folding the batches back in id order.
    const sorted = ids.sort();
    const nodes: ContextNode[] = [];
    for (let i = 0; i < sorted.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(
        sorted.slice(i, i + READ_CONCURRENCY).map(async (id) => {
          try {
            return await this.readDocument(id);
          } catch (err) {
            // Unreadable / malformed markdown — skip rather than fail the list,
            // but log so a silently-dropped doc is traceable.
            console.error("[FlatNestStorage] skipped unreadable doc", id, err);
            return null;
          }
        }),
      );
      for (const node of batch) if (node) nodes.push(node);
    }
    return nodes;
  }
}

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
    let nonMd = 0;
    let metaSkip = 0;
    let hiddenSkip = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".md")) {
        nonMd++;
        continue;
      }
      if (META_FILES.has(e.name)) {
        metaSkip++;
        continue;
      }
      // Dirent.parentPath (Node ≥20.12); `path` is the older alias.
      const dir = (e as any).parentPath ?? (e as any).path ?? root;
      const rel = relative(root, join(dir, e.name)).split(sep).join("/");
      // Skip anything inside a hidden dir or node_modules.
      if (rel.split("/").some(isSkippedSegment)) {
        hiddenSkip++;
        continue;
      }
      ids.push(rel.replace(/\.md$/, ""));
    }
    console.log(
      `[import] discover: md=${ids.length} nonMd=${nonMd} meta=${metaSkip} hidden=${hiddenSkip}`,
    );

    const nodes: ContextNode[] = [];
    for (const id of ids.sort()) {
      try {
        nodes.push(await this.readDocument(id));
      } catch (err) {
        // Unreadable / malformed markdown — skip rather than fail the list,
        // but log so a silently-dropped doc is traceable.
        console.error("[FlatNestStorage] skipped unreadable doc", id, err);
      }
    }
    if (nodes.length !== ids.length) {
      console.log(
        `[import] discover: unreadable=${ids.length - nodes.length} (of ${ids.length} md files)`,
      );
    }
    return nodes;
  }
}

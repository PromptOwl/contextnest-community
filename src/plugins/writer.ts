/**
 * The Community write port for the engine's plugin host. Every plugin draft
 * lands through createNode / updateNode — the same path a human edit takes —
 * so it gets governance (draft-first + review on a governed nest), a
 * node_versions row with author `system:plugin:<name>`, authorship chips
 * that already hide `system:` authors, and mention/notification wiring.
 *
 * Conflict rule (the one the engine also enforces, expressed in Community
 * terms): if the node's latest version was authored by anyone other than this
 * plugin, someone edited it locally since the last plugin write — it is NOT
 * overwritten. The item is reported as a conflict and re-surfaces every run
 * until resolved (edit it back, or delete it so the plugin recreates it).
 */
import { authorFor, bodyHash, type DraftWriter, type StoredProvenance } from "@promptowl/contextnest-engine/plugins";
import { createNode, updateNode, folderToSegments } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";
import { getVersions } from "../governance/version-service.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { submitForReview } from "../governance/review-service.js";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** nodes/<folder…>/<draft path…>, every segment slugified — traversal-safe. */
export function nodeIdFor(folder: string | null | undefined, draftPath: string): string {
  const segs = [...(folder ? folderToSegments(folder) : []), ...draftPath.split("/").map(slugify).filter(Boolean)];
  return `nodes/${segs.join("/")}`;
}

export function communityWriter(nestId: string): DraftWriter {
  return async (_ctx, plugin, draft, target) => {
    const author = authorFor(plugin.manifest.name);
    const id = nodeIdFor(target.folder, draft.path);
    const provenance: StoredProvenance = { ...draft.provenance, bodyHash: bodyHash(draft.body) };
    const changeNote = `Ingested by ${plugin.manifest.name}: ${draft.provenance.externalId}@${draft.provenance.hash.slice(0, 12)}`;

    const versions = await getVersions(nestId, id);
    const latest = versions[0];
    if (latest) {
      if (latest.editedBy !== author) return { id, outcome: "conflict" };
      let prev: StoredProvenance | undefined;
      try {
        const { storage } = await engineCache.get(nestId);
        const doc = await storage.readDocument(id);
        prev = (doc.frontmatter.metadata as { provenance?: StoredProvenance } | undefined)?.provenance;
        // Belt and braces for a version row that says "ours" but a body that
        // doesn't: an out-of-band file edit is still a human edit.
        if (prev && bodyHash(doc.body) !== prev.bodyHash) return { id, outcome: "conflict" };
      } catch {
        prev = undefined;
      }
      if (prev && prev.hash === draft.provenance.hash && prev.mode === draft.provenance.mode) return { id, outcome: "unchanged" };
      await updateNode(nestId, id, { title: draft.title, content: draft.body, tags: draft.tags, metadata: { provenance }, changeNote }, author, { notifyMentions: false });
      return { id, outcome: "updated" };
    }

    // No version rows: either brand new, or a file that exists without history
    // (an import). The engine-side create refuses to clobber an existing id,
    // so an unowned file surfaces as a conflict rather than a silent rewrite.
    let exists = false;
    try {
      const { storage } = await engineCache.get(nestId);
      await storage.readDocument(id);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) return { id, outcome: "conflict" };

    const governed = await isStewardshipEnabled(nestId);
    const result = await createNode(
      nestId,
      { id, title: draft.title, content: draft.body, type: draft.type, tags: draft.tags, metadata: { provenance }, changeNote } as any,
      author,
      { notifyMentions: false },
    );
    // A governed nest lands the node as a draft; hand it to the review queue so
    // stewards see it exactly like a human submission (status → pending_review).
    if (governed) {
      try {
        await submitForReview({ nestId, nodeId: id, version: result.version, requestedBy: author, note: changeNote });
      } catch (err) {
        console.warn(`[plugins] ${plugin.manifest.name}: created ${id} but could not submit for review:`, (err as Error).message);
      }
    }
    return { id, outcome: "created" };
  };
}

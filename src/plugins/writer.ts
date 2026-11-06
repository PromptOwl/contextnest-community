/**
 * The Community write port for the engine's plugin host — the governed writer.
 *
 * Every draft lands through createNode / updateNode, the same path a person's
 * edit takes, authored by the plugin's own SYSTEM identity (a system_accounts
 * principal with a write grant on this nest — see identity.ts), never by the
 * person who pressed Run. That one choice carries the rest:
 *  - structure rules: the engine enforces the nest's enforced structure on
 *    every create/update, so a draft a rule refuses fails that item (the
 *    host records it under `failed` with the rule's own words) and nothing
 *    is written;
 *  - the review gate: the system is an editor, not an owner, so on a
 *    governed nest its write lands as a draft and is submitted for review —
 *    never self-approved on the authority of whoever configured the plugin;
 *  - attribution: node_versions, the activity trace and authorship chips all
 *    name the system.
 *
 * Conflict rule — the engine's own: the node's live title, tags and body must
 * still match what this plugin last wrote (editHash in metadata.provenance).
 * Otherwise — a human edit, a node the plugin never wrote — it is NOT
 * overwritten; the item is a conflict and re-surfaces every run until someone
 * resolves it. Content, not the version author, is compared, so a steward's
 * approval (a version row, no content change) is not an edit.
 */
import { editHash, type DraftWriter, type StoredProvenance } from "@promptowl/contextnest-engine/plugins";
import { createNode, updateNode, folderToSegments } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { submitForReview, getPendingReview } from "../governance/review-service.js";
import { getVersion } from "../governance/version-service.js";

/** nodes/<folder…>/<draft path…>, every segment slugified — traversal-safe. */
export function nodeIdFor(folder: string | null | undefined, draftPath: string): string {
  const segs = [...(folder ? folderToSegments(folder) : []), ...folderToSegments(draftPath)];
  return `nodes/${segs.join("/")}`;
}

/**
 * Hand a plugin-written version to the review queue unless one is open, or the
 * nest's posture already published it (prime-only review, an ungoverned
 * nest). The DB version row is the truth for that.
 */
async function ensureReviewRequested(nestId: string, nodeId: string, version: number, author: string, note: string): Promise<void> {
  const row = await getVersion(nestId, nodeId, version);
  if (row && (row.status === "published" || row.status === "approved")) return;
  if (await getPendingReview(nestId, nodeId)) return;
  await submitForReview({ nestId, nodeId, version, requestedBy: author, note });
}

export function communityWriter(nestId: string, authorEmail: string): DraftWriter {
  return async (_ctx, plugin, draft, target) => {
    const id = nodeIdFor(target.folder, draft.path);
    const provenance: StoredProvenance = { ...draft.provenance, bodyHash: editHash(draft) };
    const changeNote = `Ingested by ${plugin.manifest.name}: ${draft.provenance.externalId}@${draft.provenance.hash.slice(0, 12)}`;
    const governed = await isStewardshipEnabled(nestId);

    const { storage } = await engineCache.get(nestId);
    let existing: Awaited<ReturnType<typeof storage.readDocument>> | null = null;
    try {
      existing = await storage.readDocument(id);
    } catch (e) {
      // Only "no such document" means create; a file that exists but won't
      // parse is a real error, not a green light to create over it.
      if ((e as { code?: string })?.code !== "DOCUMENT_NOT_FOUND") throw e;
    }

    if (existing) {
      const prev = (existing.frontmatter.metadata as { provenance?: StoredProvenance } | undefined)?.provenance;
      const ours = !!prev && prev.plugin === draft.provenance.plugin && prev.externalId === draft.provenance.externalId;
      const untouched =
        ours &&
        editHash({ title: existing.frontmatter.title, tags: existing.frontmatter.tags, body: existing.body }) === prev!.bodyHash;
      if (!untouched) return { id, outcome: "conflict" };
      if (prev!.hash === draft.provenance.hash && prev!.mode === draft.provenance.mode) return { id, outcome: "unchanged" };
      const result = await updateNode(
        nestId,
        id,
        { title: draft.title, content: draft.body, tags: draft.tags, provenance: provenance as unknown as Record<string, unknown>, changeNote },
        authorEmail,
        { notifyMentions: false },
      );
      // On a governed nest the update is a draft; without this it would sit
      // unsubmitted while readers keep seeing the stale published version.
      if (governed) await ensureReviewRequested(nestId, id, result.version, authorEmail, changeNote);
      return { id, outcome: "updated" };
    }

    const result = await createNode(
      nestId,
      { id, title: draft.title, content: draft.body, type: draft.type, tags: draft.tags, provenance: provenance as unknown as Record<string, unknown> },
      authorEmail,
      // A system is never a document's reviewer: creator-reviews would let
      // v1 publish on the plugin's own say-so.
      { notifyMentions: false, creatorReviews: false },
    );
    if (governed) await ensureReviewRequested(nestId, id, result.version, authorEmail, changeNote);
    return { id, outcome: "created" };
  };
}

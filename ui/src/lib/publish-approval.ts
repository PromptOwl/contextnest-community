/**
 * What a reader would actually get from a published link, decided from the
 * document's version list.
 *
 * `/p` serves the APPROVED snapshot and nothing else (see
 * src/nests/publish-render-routes.ts — renderPublished), so a document with no
 * approved version has nothing to publish, and one whose working copy is ahead
 * publishes the older approved text. `versions` is null while the list is
 * unread or its read failed: unknown must never block a publish the server
 * would have allowed — the server refuses the impossible case itself.
 */
export interface PublishApproval {
  /** No approved version exists — publishing would mint a link showing nothing. */
  blocked: boolean;
  /** An approved version exists, but newer unapproved edits sit above it. */
  behindDraft: boolean;
}

export function publishApproval(
  versions: { approved: number | null; current: number } | null,
): PublishApproval {
  if (versions === null) return { blocked: false, behindDraft: false };
  if (versions.approved === null) return { blocked: true, behindDraft: false };
  return {
    blocked: false,
    behindDraft: versions.current > versions.approved,
  };
}

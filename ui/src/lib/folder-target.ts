/**
 * The node-id prefix a folder share must target.
 *
 * Folder rows in the tree carry the path `folderOfNode` produced, which has any
 * leading `nodes/` stripped — but a grant is matched against whole node ids
 * (see grantCoversNode on the server), so handing it "campaigns" would cover
 * nothing at all. The share would look like it worked and grant no access.
 *
 * Rather than reassembling the id by string surgery, recover the root from a
 * document that actually lives under the folder: ids in an imported nest don't
 * all share one shape, and some carry a nest-id prefix ahead of `nodes/`.
 * Since `folderOfNode(id)` is the id minus an optional leading `nodes/` and
 * minus its last segment, putting that root back in front of the folder path
 * reconstructs the prefix exactly.
 */
export function folderGrantTarget(
  folderPath: string,
  /** Id of any document inside the folder (or its subtree); null if none. */
  sampleNodeId: string | null,
): string {
  if (sampleNodeId) {
    return sampleNodeId.startsWith("nodes/") ? `nodes/${folderPath}` : folderPath;
  }
  // Empty folder — fall back to the conventional root.
  return folderPath.startsWith("nodes/") ? folderPath : `nodes/${folderPath}`;
}

/**
 * The folder path the server will actually write, for a name typed in the UI.
 *
 * Folder paths are derived, not stored verbatim: the server slugifies each
 * segment (see folderToSegments) and drops a leading `nodes`, so "New Folder"
 * becomes `new-folder`. A caller that keeps the typed text instead ends up
 * disagreeing with the ids that come back — on the board, a column keyed by
 * the raw name would sit empty forever beside the real one.
 *
 * Kept in step with the server by hand; it stays authoritative.
 */
export function slugifyFolderPath(input: string): string {
  const segments = input
    .split("/")
    .map((seg) =>
      seg
        // Decompose so an accent comes off its letter rather than taking the
        // letter with it: "Café" → cafe, not caf.
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean);
  if (segments[0] === "nodes") segments.shift();
  return segments.join("/");
}

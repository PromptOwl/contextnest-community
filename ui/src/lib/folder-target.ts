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

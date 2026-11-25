/**
 * The Activity timeline beside a document under review: who started the draft,
 * who submitted it and why, and what reviewers decided, newest first. Pure.
 */
export interface ActivityVersion {
  version: number;
  editedBy?: string;
  editedAt?: string;
  changeNote?: string | null;
  resolvedBy?: string;
  resolutionStatus?: string;
  resolutionNote?: string;
  resolutionKind?: string;
}

export interface ActivityEvent {
  key: string;
  kind: "edited" | "submitted" | "approved" | "changes" | "rejected";
  who: string;
  text: string;
  at?: string;
  note?: string;
}

export function reviewActivity(
  versions: readonly ActivityVersion[],
  submitted: { by: string; at: string; note?: string } | null,
  limit = 12,
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  if (submitted) {
    out.push({ key: "submitted", kind: "submitted", who: submitted.by, text: "submitted for review", at: submitted.at, note: submitted.note });
  }
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    if (v.resolvedBy) {
      const kind = v.resolutionStatus === "approved" ? "approved" : v.resolutionKind === "reject" ? "rejected" : "changes";
      const text = { approved: `approved v${v.version}`, rejected: `rejected v${v.version}`, changes: `requested changes on v${v.version}` }[kind];
      out.push({ key: `r${v.version}`, kind, who: v.resolvedBy, text, note: v.resolutionNote });
    }
    if (v.editedBy) {
      out.push({
        key: `v${v.version}`,
        kind: "edited",
        who: v.editedBy,
        text: v.version === 1 ? "started this document" : `saved v${v.version}`,
        at: v.editedAt,
        note: v.changeNote ?? undefined,
      });
    }
  }
  return out.slice(0, limit);
}

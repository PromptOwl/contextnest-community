/**
 * My Work's Mentions as an inbox (PO-1200, AC-C3-08): rows grouped by nest,
 * nests in the order their newest mention arrived, rows newest first inside
 * each (the server's order). Pure.
 */
import type { MentionItem } from "./api";

export interface MentionGroup {
  nest_id: string;
  nest_name: string;
  rows: MentionItem[];
}

export function groupMentionsByNest(mentions: readonly MentionItem[]): MentionGroup[] {
  const groups = new Map<string, MentionGroup>();
  for (const m of mentions) {
    const g = groups.get(m.nest_id);
    if (g) g.rows.push(m);
    else groups.set(m.nest_id, { nest_id: m.nest_id, nest_name: m.nest_name, rows: [m] });
  }
  return [...groups.values()];
}

/** "#ops" for a channel mention, the document's title otherwise. */
export function mentionPlace(m: Pick<MentionItem, "channel" | "title"> & { kind?: MentionItem["kind"] }): string {
  if (m.kind === "conversation") return "a direct message";
  return m.channel ? `#${m.channel}` : m.title;
}

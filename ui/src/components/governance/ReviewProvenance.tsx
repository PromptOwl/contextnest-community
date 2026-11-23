/**
 * Where a change came from, on the review pane: who submitted it and when,
 * which agent (and session) wrote it, and who sealed the latest version.
 * Every row is shown only when the server has it, so a plain human edit reads
 * as a short card and an agent write as a fuller one.
 */
import { Anchor } from "lucide-react";
import { parseServerDate } from "@/lib/dates";
import type { ClientAttribution } from "../../lib/client-attribution";

export interface ProvenanceLastEdit {
  version: number;
  edited_by: string;
  edited_by_system?: string;
  edited_at: string;
  client?: ClientAttribution;
}

export interface ProvenanceRow {
  label: string;
  value: string;
}

function when(dateStr?: string): string {
  const d = dateStr ? parseServerDate(dateStr) : null;
  return d
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}

/** The rows to show, in order. Pure, so what is shown is testable without a render. */
export function provenanceRows(input: {
  requestedBy: string;
  requestedAt?: string;
  runId?: string;
  lastEdit?: ProvenanceLastEdit | null;
}): ProvenanceRow[] {
  const rows: ProvenanceRow[] = [];
  const { lastEdit } = input;
  const client = lastEdit?.client;
  const agent = client?.agent !== undefined ? String(client.agent) : undefined;
  if (agent) rows.push({ label: "Written by", value: agent });
  else if (lastEdit?.edited_by_system) rows.push({ label: "Written by", value: lastEdit.edited_by_system });
  if (client) {
    const { agent: _a, session_id, ...custom } = client;
    if (session_id !== undefined && session_id !== "") rows.push({ label: "Session", value: String(session_id) });
    for (const [k, v] of Object.entries(custom)) rows.push({ label: k.replace(/[_-]+/g, " "), value: String(v) });
  }
  if (input.runId) rows.push({ label: "Agent run", value: input.runId });
  const submitted = [input.requestedBy, when(input.requestedAt)].filter(Boolean).join(" · ");
  if (submitted) rows.push({ label: "Submitted by", value: submitted });
  if (lastEdit) {
    const who = lastEdit.edited_by_system ? `${lastEdit.edited_by} via ${lastEdit.edited_by_system}` : lastEdit.edited_by;
    rows.push({ label: "Last edit", value: [`v${lastEdit.version}`, who, when(lastEdit.edited_at)].filter(Boolean).join(" · ") });
  }
  return rows;
}

export function ReviewProvenance(props: Parameters<typeof provenanceRows>[0]) {
  const rows = provenanceRows(props);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3" data-testid="review-pane-provenance">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Anchor className="h-3.5 w-3.5" /> Provenance
      </p>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="capitalize text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

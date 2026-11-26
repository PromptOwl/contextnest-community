/**
 * One line per logged task interaction (MCP context_task_log, REST
 * POST …/task-log, `ctx task log`) for the task's activity timeline:
 *
 *   "Claude Code (key ctx CLI (laptop)) on behalf of Misha · working · note"
 *
 * The agent is the caller's §9.4 `client.agent`; the key is the API key the
 * call came in on. A key with no handshake derives its label AS the agent, so
 * the label is named once rather than twice. The person is the account the
 * call authenticated as, by roster name when known.
 */
import type { ActivityEntry } from "./api";
import { displayNameFor } from "./person-name";

/** A task's own timeline: what was logged on it, its moves and its tag changes. */
export function taskActivityEntries(activity: ActivityEntry[] | undefined): ActivityEntry[] {
  return (activity ?? []).filter((a) => ["task_activity", "moved", "tags_changed"].includes(a.type));
}

export function describeTaskEntry(
  entry: Pick<ActivityEntry, "actor" | "agent" | "key">,
  people?: Array<{ email: string; name: string | null }>,
): string {
  const person = displayNameFor(entry.actor, people);
  const keyLabel = entry.key ? entry.key.label || entry.key.prefix : undefined;
  const agent = entry.agent;
  if (agent && keyLabel && agent !== keyLabel) return `${agent} (key ${keyLabel}) on behalf of ${person}`;
  if (agent || keyLabel) return `${agent || keyLabel} on behalf of ${person}`;
  return person;
}

/** The note without the "status · " prefix the server puts in `detail`. */
export function taskEntryNote(entry: Pick<ActivityEntry, "detail" | "status"> & { type?: ActivityEntry["type"] }): string {
  const d = entry.detail ?? "";
  if (entry.type === "moved") return `Moved: ${d}`;
  if (entry.type === "tags_changed") return `Tags: ${d}`;
  return entry.status && d.startsWith(`${entry.status} · `) ? d.slice(entry.status.length + 3) : d;
}

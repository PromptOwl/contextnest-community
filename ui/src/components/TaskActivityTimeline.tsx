/**
 * A task's logged interactions — what agents (and people) registered with
 * context_task_log / `ctx task log`: who, through which agent and key, the
 * status they reported, and their note. Newest first. Renders nothing until
 * something has been logged, so a fresh task stays quiet.
 */
import { useQuery } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { relTime, formatServerDate } from "../lib/dates";
import { describeTaskEntry, taskActivityEntries, taskEntryNote } from "../lib/task-activity";

const STATUS_TONES: Record<string, string> = {
  working: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  blocked: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function TaskActivityTimeline({
  nestId,
  nodeId,
  people,
}: {
  nestId: string;
  nodeId: string;
  people?: Array<{ email: string; name: string | null }>;
}) {
  const { data } = useQuery({ ...reads.nodeActivity(nestId, nodeId, 100), enabled: !!nestId && !!nodeId });
  const entries = taskActivityEntries(data?.activity);
  if (entries.length === 0) return null;
  return (
    <section className="w-full flex flex-col gap-2" data-testid="task-activity-timeline">
      <h3 className="text-xs font-medium text-muted-foreground">Activity</h3>
      <ol className="flex flex-col gap-2 border-l border-border pl-3">
        {entries.map((e) => (
          <li key={e.refId ?? `${e.at}-${e.actor}`} className="text-sm leading-snug">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">{describeTaskEntry(e, people)}</span>
              {e.status && (
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONES[e.status] ?? "bg-muted"}`}>
                  {e.status}
                </span>
              )}
              <time dateTime={e.at} title={formatServerDate(e.at)}>
                {relTime(e.at)}
              </time>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground/90">{taskEntryNote(e)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

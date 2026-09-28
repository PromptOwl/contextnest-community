/** Tinted chip per node type so the type reads at a glance in dense lists. */
import { Bot, FileCode2, FileText, FileType, Table2, Wrench, Zap } from "lucide-react";

export function NodeTypeIcon({
  type,
  className = "h-4 w-4",
}: {
  type?: string;
  className?: string;
}) {
  // Tinted chip per node type so the type reads at a glance in dense lists —
  // a bare gray glyph wasn't distinguishable when most rows are documents.
  const spec =
    type === "agent"
      ? { Icon: Bot, cls: "text-violet-600 dark:text-violet-400 bg-violet-500/10", label: "Agent" }
      : type === "skill"
        ? { Icon: Zap, cls: "text-blue-600 dark:text-blue-400 bg-blue-500/10", label: "Skill" }
        : type === "artifact"
          ? { Icon: FileCode2, cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10", label: "Artifact" }
          : type === "tool"
            ? { Icon: Wrench, cls: "text-teal-600 dark:text-teal-400 bg-teal-500/10", label: "Tool" }
            : type === "table"
              ? { Icon: Table2, cls: "text-cyan-600 dark:text-cyan-400 bg-cyan-500/10", label: "Table" }
              : type === "pdf"
                ? { Icon: FileType, cls: "text-rose-600 dark:text-rose-400 bg-rose-500/10", label: "PDF" }
                : { Icon: FileText, cls: "text-slate-500 dark:text-slate-400 bg-slate-500/10", label: "Document" };
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md p-1 shrink-0 ${spec.cls}`}
      title={spec.label}
    >
      <spec.Icon className={className} />
    </span>
  );
}

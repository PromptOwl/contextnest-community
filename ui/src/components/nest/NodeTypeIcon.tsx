/** One icon + colour per node type, shared by every list, tree and card. */
import { Bot, FileCode2, FileText, FileType, LayoutDashboard, ListTodo, Table2, Wrench, Zap } from "lucide-react";

const SPECS: Record<string, { Icon: typeof FileText; text: string; bg: string; label: string }> = {
  agent: { Icon: Bot, text: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10", label: "Agent" },
  skill: { Icon: Zap, text: "text-blue-600 dark:text-blue-400", bg: "bg-blue-500/10", label: "Skill" },
  artifact: { Icon: FileCode2, text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", label: "Artifact" },
  tool: { Icon: Wrench, text: "text-teal-600 dark:text-teal-400", bg: "bg-teal-500/10", label: "Tool" },
  table: { Icon: Table2, text: "text-cyan-600 dark:text-cyan-400", bg: "bg-cyan-500/10", label: "Table" },
  pdf: { Icon: FileType, text: "text-rose-600 dark:text-rose-400", bg: "bg-rose-500/10", label: "PDF" },
  task: { Icon: ListTodo, text: "text-indigo-600 dark:text-indigo-400", bg: "bg-indigo-500/10", label: "Task" },
  view: { Icon: LayoutDashboard, text: "text-fuchsia-600 dark:text-fuchsia-400", bg: "bg-fuchsia-500/10", label: "View" },
};
const DOCUMENT = { Icon: FileText, text: "text-slate-500 dark:text-slate-400", bg: "bg-slate-500/10", label: "Document" };

export function nodeTypeSpec(type?: string) {
  return (type && SPECS[type]) || DOCUMENT;
}

export function NodeTypeIcon({
  type,
  className = "h-4 w-4",
}: {
  type?: string;
  className?: string;
}) {
  // Tinted chip per node type so the type reads at a glance in dense lists —
  // a bare gray glyph wasn't distinguishable when most rows are documents.
  const spec = nodeTypeSpec(type);
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md p-1 shrink-0 ${spec.text} ${spec.bg}`}
      title={spec.label}
    >
      <spec.Icon className={className} />
    </span>
  );
}

/** The same icon without the chip, for compact tree rows and cards. */
export function NodeTypeGlyph({ type, className = "h-4 w-4" }: { type?: string; className?: string }) {
  const spec = nodeTypeSpec(type);
  return <spec.Icon className={`shrink-0 ${spec.text} ${className}`} aria-label={spec.label} />;
}

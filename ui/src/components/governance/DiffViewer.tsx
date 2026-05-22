/**
 * DiffViewer — renders a unified patch as colored hunks.
 *
 * Minimal in-repo renderer: keeps zero extra deps and matches the
 * monospaced look already used in CodeBlock components. Good enough for
 * external-edit review; can be swapped for a richer side-by-side
 * library later.
 */
import { cn } from "@/lib/utils";

interface DiffViewerProps {
  patch: string;
  className?: string;
}

export function DiffViewer({ patch, className }: DiffViewerProps) {
  const lines = patch.split(/\r?\n/);

  return (
    <pre
      className={cn(
        "rounded-md border bg-background text-xs leading-relaxed overflow-x-auto",
        "max-h-96",
        className,
      )}
      data-testid="diff-viewer"
    >
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          <code className="block px-3 whitespace-pre">{line || " "}</code>
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "bg-muted/60 text-muted-foreground font-semibold";
  }
  if (line.startsWith("@@")) {
    return "bg-blue-100/60 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200";
  }
  if (line.startsWith("+")) {
    return "bg-green-100/60 dark:bg-green-950/40 text-green-900 dark:text-green-200";
  }
  if (line.startsWith("-")) {
    return "bg-red-100/60 dark:bg-red-950/40 text-red-900 dark:text-red-200";
  }
  return "text-foreground/80";
}

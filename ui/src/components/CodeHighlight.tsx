import { useMemo } from "react";
import type { ReactNode } from "react";
import { createLowlight, common } from "lowlight";

/**
 * Read view for a TOOL node's body: the same lowlight highlighting the
 * markdown editor's code blocks use, applied to a plain source string. The
 * language is auto-detected — a tool body carries no fence info — and the
 * `.hljs-*` token colors come from the editor stylesheet.
 */

const lowlight = createLowlight(common);

/** lowlight emits a hast tree of nested spans; render it as React nodes. */
function renderHast(nodes: any[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return n.value;
    const className = (n.properties?.className ?? []).join(" ");
    return (
      <span key={i} className={className}>
        {renderHast(n.children ?? [])}
      </span>
    );
  });
}

export function CodeHighlight({
  code,
  className = "",
  ...rest
}: {
  code: string;
  className?: string;
} & Record<string, unknown>) {
  const tree = useMemo(() => {
    if (!code.trim()) return null;
    try {
      return renderHast(lowlight.highlightAuto(code).children as any[]);
    } catch {
      // Auto-detection failing must never blank the body — fall back to plain.
      return null;
    }
  }, [code]);

  return (
    <pre
      className={`overflow-x-auto p-4 font-mono text-xs leading-relaxed whitespace-pre ${className}`}
      {...rest}
    >
      <code>{tree ?? code}</code>
    </pre>
  );
}

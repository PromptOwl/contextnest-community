/**
 * Human-readable rendering of the agent manual (/llms.txt) — same content,
 * proper typography. The raw text URL stays the canonical machine surface;
 * this page is for the humans setting those agents up. A short framing block
 * on top says what the manual is and points people at How it works.
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, ExternalLink, Loader2, Plug, Code2, Terminal } from "lucide-react";
import { PageTitle } from "@/components/ui/page-title";

const WAYS_IN: [typeof Plug, string, string][] = [
  [Plug, "Connect an MCP client", "Claude Code, Cursor, VS Code or Claude Desktop talk to a nest directly. See “MCP” below."],
  [Code2, "Call the REST API", "Every read is deterministic: same selector, same context. See “Deterministic retrieval API” below."],
  [Terminal, "Use the ctx CLI", "Query a hosted nest from a terminal or a script. See “From the ctx CLI” below."],
];

export function AgentDocsPage({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [manual, setManual] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/llms.txt")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load manual (${r.status})`);
        return r.text();
      })
      .then((t) => !cancelled && setManual(t))
      .catch((e) => !cancelled && setError(e?.message || "Failed to load"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="w-full space-y-6">
      <PageTitle
        icon={BookOpen}
        title="Docs"
        description="How agents talk to this server: keys, endpoints, MCP tools and the CLI."
        className="mb-0"
        actions={
          <a
            href="/llms.txt"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Raw llms.txt (for agents)
            <ExternalLink className="h-3 w-3" />
          </a>
        }
      />

      <div className="rounded-lg border-l-2 border-primary bg-muted/40 p-4 text-sm text-muted-foreground">
        This is the manual an agent reads when you point it at{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">/llms.txt</code>. It documents shapes, never
        data. Looking for how to use the app yourself?{" "}
        <button type="button" onClick={onOpenGuide} className="font-medium text-foreground underline underline-offset-2">
          Start with How it works
        </button>
        .
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {WAYS_IN.map(([Icon, title, body]) => (
          <div key={title} className="rounded-lg border bg-card p-3">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <Icon className="h-4 w-4 text-primary" />
              {title}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {!manual && !error && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading docs…
        </div>
      )}
      {manual && (
        <article className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{manual}</ReactMarkdown>
        </article>
      )}
    </div>
  );
}

/**
 * Human-readable rendering of the agent manual (/llms.txt) — same content,
 * proper typography. The raw text URL stays the canonical machine surface;
 * this page is for the humans setting those agents up.
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, ExternalLink, Loader2 } from "lucide-react";
import { PageTitle } from "@/components/ui/page-title";

export function AgentDocsPage() {
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
    <div className="w-full space-y-4">
      <PageTitle
        icon={BookOpen}
        title="Docs"
        description="The agent manual (llms.txt), rendered for the humans setting those agents up."
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

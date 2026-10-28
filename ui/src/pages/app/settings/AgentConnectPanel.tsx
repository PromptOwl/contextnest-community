/**
 * "Connecting agents" — the admin-facing answer to "how do I wire this server
 * into <tool>?", which is the question every operator gets asked by everyone
 * on their team.
 *
 * Docs-only: nothing here writes a setting, so the tab carries no draft keys
 * (same shape as the Community sites tab). The text itself lives in the pure,
 * unit-tested module `lib/agent-connect-docs` — this file is only the
 * rendering shell.
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DEFAULT_HARNESS,
  HARNESSES,
  harnessById,
  renderHarnessDoc,
  renderAllHarnessDocs,
  type HarnessKind,
} from "../../../lib/agent-connect-docs";

const KIND_LABEL: Record<HarnessKind, string> = {
  chat: "Chat",
  cli: "Command line",
  editor: "Editors",
};

const KIND_ORDER: HarnessKind[] = ["chat", "cli", "editor"];

export function AgentConnectPanel({
  publicBaseUrl,
  openMode,
}: {
  /** The admin-configured public base URL; empty when it has never been set. */
  publicBaseUrl: string;
  openMode: boolean;
}) {
  const [selectedId, setSelectedId] = useState(DEFAULT_HARNESS.id);

  // These instructions are copied and pasted into someone else's machine, so
  // they have to carry the URL the OUTSIDE world uses. window.location.origin
  // is a reasonable guess for a single-origin deployment, but it's wrong
  // behind a proxy or a private hostname — hence the warning below rather
  // than silently shipping a URL that only works from the admin's browser.
  const configured = publicBaseUrl.trim();
  const serverUrl = configured || window.location.origin;

  const ctx = useMemo(() => ({ serverUrl, openMode }), [serverUrl, openMode]);
  const selected = harnessById(selectedId) ?? DEFAULT_HARNESS;
  const body = useMemo(() => renderHarnessDoc(selected, ctx), [selected, ctx]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Connecting agents</CardTitle>
            <CardDescription>
              Setup steps for each AI tool your people are likely to use. Every
              one of them connects <strong>once</strong>, to the same
              server-level MCP endpoint, and that single connection reads
              across every nest the caller can see — the public ones plus
              whatever private nests they have access to. There is no per-nest
              setup, and nothing to redo when someone is added to another nest.
            </CardDescription>
          </div>
          <CopyButton
            text={renderAllHarnessDocs(ctx)}
            label="Copy all"
            toastMessage="All connection instructions copied"
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!configured && (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs"
          >
            <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              No public base URL is set, so these steps use{" "}
              <code>{serverUrl}</code> — the address of{" "}
              <em>this browser's</em> connection. Most of these tools run the
              MCP client on the vendor's servers, not the user's machine, so a
              private or proxied address will fail for them. Set the public
              base URL on the <strong>General</strong> tab.
            </span>
          </div>
        )}

        {!openMode && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <strong>Use a user-level key, not a nest-scoped one.</strong> A
              key scoped to a single nest narrows this endpoint back down to
              that nest, which looks exactly like the connect-once promise
              being broken.
            </p>
            <p>
              <strong>Each person uses their own key.</strong> A key shared
              across a team makes all of them the same user to this server, so
              they would all see the key owner's nests instead of their own.
            </p>
          </div>
        )}

        {KIND_ORDER.map((kind) => {
          const group = HARNESSES.filter((h) => h.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {KIND_LABEL[kind]}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.map((h) => (
                  <Button
                    key={h.id}
                    size="sm"
                    variant={h.id === selectedId ? "default" : "outline"}
                    // Selection is otherwise conveyed by colour alone.
                    aria-pressed={h.id === selectedId}
                    onClick={() => setSelectedId(h.id)}
                  >
                    {h.name}
                    {h.support === "oauth-only" && (
                      <Badge variant="secondary" className="ml-1.5">
                        OAuth
                      </Badge>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          );
        })}

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-start justify-between gap-4 mb-2">
            <div>
              <div className="text-sm font-medium">{selected.name}</div>
              <div className="text-xs text-muted-foreground">
                {selected.where}
              </div>
            </div>
            <CopyButton
              text={body}
              variant="ghost"
              label="Copy"
              toastMessage={`${selected.name} steps copied`}
            />
          </div>
          <article className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Every link in these bodies points at a vendor's site, so
                // none of them should navigate away from Settings.
                a: ({ ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {body}
            </ReactMarkdown>
          </article>
        </div>
      </CardContent>
    </Card>
  );
}

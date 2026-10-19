/**
 * Public /setup page — no account needed. `ctx setup` opens it with a
 * loopback ?cb; the chosen options go back to the terminal. Opened by hand,
 * it builds the equivalent `ctx init` line instead. See lib/setup-page.ts.
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, ChevronRight, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ALIAS_PATTERN,
  CHOICES_KEY,
  DEFAULT_CHOICES,
  STARTERS,
  TOOLS,
  callbackUrl,
  connectGuides,
  initCommand,
  loopbackCallback,
  type SetupChoices,
} from "@/lib/setup-page";

function savedChoices(): SetupChoices | null {
  try {
    const raw = sessionStorage.getItem(CHOICES_KEY);
    return raw ? { ...DEFAULT_CHOICES, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

export function SetupPage() {
  const params = new URLSearchParams(window.location.search);
  const cb = loopbackCallback(params.get("cb"));
  const state = params.get("state") ?? "";
  const done = params.get("done") === "1";
  const [c, setC] = useState<SetupChoices>(() => savedChoices() ?? DEFAULT_CHOICES);
  const set = <K extends keyof SetupChoices>(k: K, v: SetupChoices[K]) => setC((p) => ({ ...p, [k]: v }));
  const aliasOk = ALIAS_PATTERN.test(c.alias);
  const command = useMemo(() => initCommand(c), [c]);
  const guides = useMemo(() => connectGuides(c.alias), [c.alias]);

  const send = () => {
    if (!cb || !aliasOk || !c.name.trim()) return;
    try {
      sessionStorage.setItem(CHOICES_KEY, JSON.stringify(c));
    } catch {
      // The connect steps fall back to a placeholder alias.
    }
    window.location.assign(callbackUrl(cb, state, c));
  };

  const toggleTool = (id: string) =>
    set("tools", c.tools.includes(id) ? c.tools.filter((t) => t !== id) : [...c.tools, id]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Set up Context Nest</h1>
          <p className="text-sm text-muted-foreground">
            Choose how your vault starts, then connect it to your coding agent.
          </p>
        </header>

        {done ? (
          <div className="flex items-start gap-3 rounded-lg border border-green-600/40 bg-green-600/10 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
            <div>
              <p className="font-medium">Your choices are in the terminal.</p>
              <p className="text-muted-foreground">
                Go back to the terminal to confirm and create the vault. Then follow the steps below.
              </p>
            </div>
          </div>
        ) : (
          <section className="space-y-5 rounded-lg border bg-card p-5">
            <h2 className="text-lg font-semibold">1. Vault options</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Vault name</Label>
                <Input id="name" value={c.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alias">Alias</Label>
                <Input id="alias" value={c.alias} maxLength={64} onChange={(e) => set("alias", e.target.value)} />
                <p className={`text-xs ${aliasOk ? "text-muted-foreground" : "text-red-500"}`}>
                  Letters, digits, - and _. Use it as <code>--vault {aliasOk ? c.alias : "<alias>"}</code>.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="desc">Description (optional)</Label>
              <Textarea id="desc" rows={2} maxLength={500} value={c.description} onChange={(e) => set("description", e.target.value)} />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Template</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {[...STARTERS, { id: "", name: "Empty vault", description: "No starter content. Add your own notes." }].map((s) => (
                  <label
                    key={s.id || "empty"}
                    className={`cursor-pointer rounded-md border p-3 text-sm ${c.starter === s.id ? "border-primary bg-primary/5" : ""}`}
                  >
                    <input type="radio" name="starter" className="mr-2" checked={c.starter === s.id} onChange={() => set("starter", s.id)} />
                    <span className="font-medium">{s.name}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{s.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {c.starter && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Agent instruction files</legend>
                <div className="flex flex-wrap gap-3">
                  {TOOLS.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={c.tools.includes(t.id)} onChange={() => toggleTool(t.id)} />
                      {t.name} <span className="text-xs text-muted-foreground">({t.hint})</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Layout</legend>
              <div className="flex gap-4 text-sm">
                {(["structured", "obsidian"] as const).map((l) => (
                  <label key={l} className="flex items-center gap-2">
                    <input type="radio" name="layout" checked={c.layout === l} onChange={() => set("layout", l)} />
                    {l === "structured" ? "Structured (nodes/ folders)" : "Obsidian (flat notes)"}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.setDefault} onChange={(e) => set("setDefault", e.target.checked)} />
                Make this my default vault
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={c.encrypted} onChange={(e) => set("encrypted", e.target.checked)} />
                Encrypt note content at rest
              </label>
              {c.encrypted && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  Caution: if you lose the key and the recovery passphrase, you lose the data.
                </p>
              )}
            </div>

            {cb ? (
              <Button onClick={send} disabled={!aliasOk || !c.name.trim()}>
                <Terminal className="mr-2 h-4 w-4" /> Send to terminal
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border-l-4 border-primary bg-primary/10 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Terminal className="h-4 w-4 shrink-0 text-primary" />
                  <span>
                    Run this in the folder for your vault (or run <code>ctx setup</code> to send the choices directly):
                  </span>
                </p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded-md bg-background p-3 text-xs">{command}</pre>
                  <Button variant="outline" size="icon" aria-label="Copy command" onClick={() => navigator.clipboard?.writeText(command)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">2. Connect your agent</h2>
          <p className="text-sm text-muted-foreground">
            Open the tool you use. Each one has its own steps.
          </p>
          {guides.map((g) => (
            <details key={g.id} className="group rounded-lg border bg-card" open={done && g.id === "claude-code"}>
              <summary className="flex cursor-pointer list-none items-center gap-2 p-4 font-medium">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                {g.name}
              </summary>
              <article className="prose prose-sm dark:prose-invert max-w-none border-t px-4 pb-4 pt-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{g.steps}</ReactMarkdown>
              </article>
            </details>
          ))}
        </section>
      </main>
    </div>
  );
}

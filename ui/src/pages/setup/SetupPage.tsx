/**
 * Public /setup page — no account needed. `ctx setup` opens it with a
 * loopback ?cb; the chosen options go back to the terminal. Opened by hand,
 * it builds the equivalent `ctx init` line instead. See lib/setup-page.ts.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircle2,
  ChevronRight,
  Cloud,
  HardDrive,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getHealth } from "@/lib/api";
import { PLUGIN_SETUP_COMMANDS, setupSignInCommand } from "@/lib/connect";
import {
  ALIAS_PATTERN,
  CHOICES_KEY,
  DEFAULT_CHOICES,
  STARTERS,
  TOOLS,
  callbackUrl,
  cloudGuides,
  cloudServer,
  connectGuides,
  detectedTools,
  filterGuides,
  initCommand,
  loginCommand,
  loopbackCallback,
  type SetupChoices,
} from "@/lib/setup-page";

/** One quick way to connect: a label, a short note, a copyable command. */
function Choice({
  title,
  command,
  children,
}: {
  title: string;
  command: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-card p-4">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{children}</p>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {command}
        </pre>
        <CopyButton text={command} size="icon" aria-label={`Copy: ${title}`} />
      </div>
    </div>
  );
}

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
  const detected = detectedTools(window.location.hash);
  // This page is served by a cloud server, so that server is the natural default.
  const [c, setC] = useState<SetupChoices>(
    () =>
      savedChoices() ?? {
        ...DEFAULT_CHOICES,
        server: window.location.origin,
        tools: detected ?? DEFAULT_CHOICES.tools,
      }
  );
  const set = <K extends keyof SetupChoices>(k: K, v: SetupChoices[K]) =>
    setC((p) => ({ ...p, [k]: v }));
  const aliasOk = ALIAS_PATTERN.test(c.alias);
  const cloud = c.mode === "cloud";
  const ready =
    aliasOk && (cloud ? cloudServer(c.server) !== null : c.name.trim() !== "");
  const command = useMemo(
    () => (cloud ? loginCommand(c) : initCommand(c)),
    [c, cloud]
  );
  const guides = useMemo(
    () => (cloud ? cloudGuides(c.server, c.alias) : connectGuides(c.alias)),
    [cloud, c.server, c.alias]
  );
  const [query, setQuery] = useState("");
  const shown = filterGuides(guides, query);
  // Unknown (null) until /health answers; the sign-in box waits for it.
  const [authMode, setAuthMode] = useState<string | null>(null);
  useEffect(() => {
    getHealth().then((h) => setAuthMode(h.auth_mode), () => {});
  }, []);
  // /setup is served by this server, so the page's own origin is the one to sign
  // in to; the Connect dialogs, inside the app, use the configured serverUrl.
  const loginCmd = setupSignInCommand(window.location.origin, authMode, cloud);

  const send = () => {
    if (!cb || !ready) return;
    try {
      sessionStorage.setItem(CHOICES_KEY, JSON.stringify(c));
    } catch {
      // The connect steps fall back to a placeholder alias.
    }
    window.location.assign(callbackUrl(cb, state, c));
  };

  const toggleTool = (id: string) =>
    set(
      "tools",
      c.tools.includes(id) ? c.tools.filter((t) => t !== id) : [...c.tools, id]
    );

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
                {cloud
                  ? "Go back to the terminal to sign in to the server. Then follow the steps below."
                  : "Go back to the terminal to confirm and create the vault. Then follow the steps below."}
              </p>
            </div>
          </div>
        ) : (
          <section className="space-y-5 rounded-lg border bg-card p-5">
            <h2 className="text-lg font-semibold">1. Vault options</h2>

            <Tabs
              value={c.mode}
              onValueChange={(m) => set("mode", m as SetupChoices["mode"])}
            >
              <TabsList>
                <TabsTrigger value="local">
                  <HardDrive className="mr-2 h-4 w-4" /> Local vault
                </TabsTrigger>
                <TabsTrigger value="cloud">
                  <Cloud className="mr-2 h-4 w-4" /> Cloud nest
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-sm text-muted-foreground">
              {cloud
                ? "Connect to nests on a hosted server. The terminal opens a browser sign-in and registers every nest you can see under one alias."
                : "Create a vault on this computer. Your notes stay in a folder you choose."}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              {cloud ? (
                <div className="space-y-1.5">
                  <Label htmlFor="server">Server URL</Label>
                  <Input
                    id="server"
                    value={c.server}
                    maxLength={200}
                    onChange={(e) => set("server", e.target.value)}
                  />
                  {!cloudServer(c.server) && (
                    <p className="text-xs text-red-500">
                      Use an https:// address.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="name">Vault name</Label>
                  <Input
                    id="name"
                    value={c.name}
                    maxLength={120}
                    onChange={(e) => set("name", e.target.value)}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="alias">Alias</Label>
                <Input
                  id="alias"
                  value={c.alias}
                  maxLength={64}
                  onChange={(e) => set("alias", e.target.value)}
                />
                <p
                  className={`text-xs ${
                    aliasOk ? "text-muted-foreground" : "text-red-500"
                  }`}
                >
                  Letters, digits, - and _. Use it as{" "}
                  <code>--vault {aliasOk ? c.alias : "<alias>"}</code>.
                </p>
              </div>
            </div>

            {!cloud && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="desc">Description (optional)</Label>
                  <Textarea
                    id="desc"
                    rows={2}
                    maxLength={500}
                    value={c.description}
                    onChange={(e) => set("description", e.target.value)}
                  />
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Template</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      ...STARTERS,
                      {
                        id: "",
                        name: "Empty vault",
                        description: "No starter content. Add your own notes.",
                      },
                    ].map((s) => (
                      <label
                        key={s.id || "empty"}
                        className={`cursor-pointer rounded-md border p-3 text-sm ${
                          c.starter === s.id
                            ? "border-primary bg-primary/5"
                            : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="starter"
                          className="mr-2"
                          checked={c.starter === s.id}
                          onChange={() => set("starter", s.id)}
                        />
                        <span className="font-medium">{s.name}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {s.description}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            <details className="group rounded-lg border">
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                Advanced settings
              </summary>
              <div className="space-y-4 border-t p-4">
                {!cloud && (
                  <>
                    {c.starter && (
                      <fieldset className="space-y-2">
                        <legend className="text-sm font-medium">
                          Agent instruction files
                        </legend>
                        {detected && (
                          <p className="text-xs text-muted-foreground">
                            Tools found on this computer are already selected.
                          </p>
                        )}
                        <div className="flex flex-wrap gap-3">
                          {TOOLS.map((t) => (
                            <label
                              key={t.id}
                              className="flex items-center gap-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={c.tools.includes(t.id)}
                                onChange={() => toggleTool(t.id)}
                              />
                              {t.name}{" "}
                              <span className="text-xs text-muted-foreground">
                                ({t.hint})
                              </span>
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
                            <input
                              type="radio"
                              name="layout"
                              checked={c.layout === l}
                              onChange={() => set("layout", l)}
                            />
                            {l === "structured"
                              ? "Structured (nodes/ folders)"
                              : "Obsidian (flat notes)"}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
                <div className="space-y-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={c.setDefault}
                      onChange={(e) => set("setDefault", e.target.checked)}
                    />
                    Make this my default vault
                  </label>
                  {!cloud && (
                    <>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={c.encrypted}
                          onChange={(e) => set("encrypted", e.target.checked)}
                        />
                        Encrypt note content at rest
                      </label>
                      {c.encrypted && (
                        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                          Caution: if you lose the key and the recovery
                          passphrase, you lose the data.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </details>

            {cb ? (
              <Button onClick={send} disabled={!ready}>
                <Terminal className="mr-2 h-4 w-4" /> Send to terminal
              </Button>
            ) : (
              <div className="space-y-2 rounded-lg border-l-4 border-primary bg-primary/10 p-4">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Terminal className="h-4 w-4 shrink-0 text-primary" />
                  <span>
                    {cloud
                      ? "Run this in a terminal"
                      : "Run this in the folder for your vault"}{" "}
                    (or run <code>ctx setup</code> to send the choices
                    directly):
                  </span>
                </p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded-md bg-background p-3 text-xs">
                    {command}
                  </pre>
                  <CopyButton text={command} size="icon" aria-label="Copy command" />
                </div>
              </div>
            )}
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">2. Connect your agent</h2>
          <p className="text-sm text-muted-foreground">
            The quickest ways in:
          </p>
          <Choice title="Claude Code plugin" command={PLUGIN_SETUP_COMMANDS}>
            Type each line inside Claude Code. The last one asks where your
            notes should live: only on this computer, or online (to use{" "}
            {window.location.host}, choose Other and enter{" "}
            <code>{window.location.origin}</code>), and connects everything.
            From then on the plugin looks up matching notes on each prompt and
            saves notes when you ask.
          </Choice>
          {loginCmd && (
            <Choice
              title={`Sign in to ${window.location.host} from a terminal`}
              command={`npm i -g @promptowl/contextnest-cli\n${loginCmd}`}
            >
              The first line installs or updates the <code>ctx</code> CLI
              (needs Node 20 or later). The second opens your browser to
              approve; then the notes you can open on {window.location.host}{" "}
              appear in <code>ctx vault list</code>. Signing in uploads
              nothing. No browser sign-in on this server? Add{" "}
              <code>--key-stdin</code> and paste a key from its Connect page.
            </Choice>
          )}
          <p className="text-sm text-muted-foreground">
            Or open the tool you use. Each one has its own steps.
          </p>
          <Input
            type="search"
            aria-label="Search setup guides"
            placeholder="Search tools and steps, for example zed or mcp"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No guide matches &ldquo;{query}&rdquo;.
            </p>
          )}
          {shown.map((g) => (
            <details
              // Remount when the search changes, so `open` applies again.
              key={`${g.id}:${query !== ""}`}
              className="group rounded-lg border bg-card"
              open={query !== "" || (done && g === guides[0])}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 p-4 font-medium">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                {g.name}
              </summary>
              <article className="prose prose-sm dark:prose-invert max-w-none border-t px-4 pb-4 pt-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {g.steps}
                </ReactMarkdown>
              </article>
            </details>
          ))}
        </section>
      </main>
    </div>
  );
}

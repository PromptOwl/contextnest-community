/**
 * Structure — one nest's own rules: which folders can exist, what goes in
 * them, how files are named and which template they start from. Every nest
 * has its own; they live in that nest's vault, so `ctx`, agents and MCP
 * writes follow them too. Owners and admins edit; everyone else who works in
 * the nest sees them read-only. Every verdict comes from the server.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Loader2, Plus, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { NestPageHeader } from "../NestPageHeader";
import { deriveNestCaps, isNestArchived } from "../../lib/nest-caps";
import { reads } from "../../lib/queries";
import * as api from "../../lib/api";
import type { ApiError, StructureRules } from "../../lib/api";
import {
  folderPatterns,
  folderRule,
  removeFolder,
  renameFolder,
  sameRules,
  setFolder,
  setSwitch,
} from "../../lib/structure-draft";
import { RuleEditor } from "./RuleEditor";
import { TemplatesTab } from "./TemplatesTab";
import { ComplianceTab } from "./ComplianceTab";

interface Props {
  nestId: string;
  nestName: string;
  isArchived?: boolean;
  onBack: () => void;
  openDocument: (nodeId: string) => void;
  /** Open at the rule governing this folder, or start a rule for it. */
  initialFolder?: string;
}

export function StructurePage({ nestId, nestName, isArchived, onBack, openDocument, initialFolder }: Props) {
  const qc = useQueryClient();
  const structure = useQuery(reads.structure(nestId));
  const report = useQuery(reads.structure(nestId, { report: true }));
  const saved = structure.data?.rules;

  // Owners and admins edit. Until the nest read lands, the page is read-only
  // rather than an editor that may vanish.
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    let ignore = false;
    qc.fetchQuery(reads.nest(nestId))
      .then((meta: any) => {
        if (ignore) return;
        const caps = deriveNestCaps({
          roles: meta?.roles ?? [],
          permission: meta?.permission ?? null,
          myStewards: meta?.myStewards ?? [],
          isOwner: meta?.permission === "owner",
          isAdmin: meta?.permission === "admin",
          isArchived: isArchived || isNestArchived(meta?.nest),
        });
        setCanManage(caps.canManage && !(isArchived || isNestArchived(meta?.nest)));
      })
      .catch(() => !ignore && setCanManage(false));
    return () => {
      ignore = true;
    };
  }, [nestId, qc, isArchived]);

  // The draft of this nest's rules. Another nest is another draft: switching
  // nests starts over from that nest's saved rules.
  const [draft, setDraft] = useState<StructureRules | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [tab, setTab] = useState("blueprint");
  useEffect(() => {
    setDraft(null);
    setSelected(null);
    setSelectedTemplate(null);
  }, [nestId]);
  useEffect(() => {
    if (saved && draft === null) setDraft(saved);
  }, [saved, draft]);

  const dirty = !!draft && !!saved && !sameRules(draft, saved);
  const patterns = draft ? folderPatterns(draft) : [];
  const current = selected && draft?.folders?.[selected] !== undefined ? selected : patterns[0] ?? null;

  // ?folder= → that folder's rule, or (for an owner) a new rule for it. Once.
  const folderHandled = useRef(false);
  useEffect(() => {
    if (!initialFolder || !draft || folderHandled.current) return;
    folderHandled.current = true;
    api
      .getStructure(nestId, { folder: initialFolder })
      .then((r) => {
        if (r.resolved && draft.folders?.[r.resolved.pattern] !== undefined) {
          setSelected(r.resolved.pattern);
        } else if (canManage) {
          const p = initialFolder.replace(/^nodes\//, "");
          setDraft((d) => (d && d.folders?.[p] === undefined ? setFolder(d, p, {}) : d));
          setSelected(p);
          toast.info(`No rule covers ${p}/ yet — this starts one. Save to keep it.`);
        }
      })
      .catch(() => {});
  }, [initialFolder, draft, nestId, canManage]);

  // The server compiles the draft as it changes: problems show under the
  // field they name before anything is saved.
  const [live, setLive] = useState<{ fieldErrors: Record<string, string>; warnings: string[] }>({ fieldErrors: {}, warnings: [] });
  useEffect(() => {
    if (!draft || !canManage || !dirty) {
      setLive({ fieldErrors: {}, warnings: structure.data?.warnings ?? [] });
      return;
    }
    let ignore = false;
    const t = setTimeout(() => {
      api
        .checkStructure(nestId, { rules: draft })
        .then((r) => !ignore && setLive({ fieldErrors: r.fieldErrors, warnings: r.warnings }))
        .catch(() => {});
    }, 400);
    return () => {
      ignore = true;
      clearTimeout(t);
    };
  }, [draft, canManage, dirty, nestId, structure.data?.warnings]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.saveStructure(nestId, draft);
      const fresh = await qc.fetchQuery(reads.structure(nestId));
      setDraft(fresh.rules);
      toast.success(
        `Structure rules saved for ${nestName}${r.violations ? ` — ${r.violations} existing item${r.violations === 1 ? "" : "s"} don't fit yet` : ""}`,
      );
    } catch (e) {
      const err = e as ApiError;
      setSaveError(err.message);
      if (err.body?.fieldErrors) setLive((l) => ({ ...l, fieldErrors: err.body!.fieldErrors! }));
    } finally {
      setSaving(false);
    }
  };

  // Turning enforcement on is confirmed with what it would refuse today.
  const [confirm, setConfirm] = useState<number | null>(null);
  const toggleEnforce = async (on: boolean) => {
    if (!draft) return;
    if (!on) {
      setDraft(setSwitch(draft, "enforce", false));
      return;
    }
    try {
      const r = await api.checkStructure(nestId, { rules: setSwitch(draft, "enforce", true), report: true });
      if (r.error) {
        toast.error(`Fix the rules first: ${r.error}`);
        return;
      }
      setConfirm(r.report?.violations.length ?? 0);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const [adding, setAdding] = useState("");
  const addRule = () => {
    const p = adding.trim().replace(/^\/+|\/+$/g, "");
    if (!draft || !p) return;
    if (draft.folders?.[p] !== undefined) {
      toast.error(`There is already a rule for ${p}.`);
      return;
    }
    setDraft(setFolder(draft, p, {}));
    setSelected(p);
    setAdding("");
  };

  const [yamlOpen, setYamlOpen] = useState(false);
  const enforced = !!draft?.structure?.enforce;
  const violations = report.data?.violations;
  const empty = !!draft && patterns.length === 0 && Object.keys(draft.templates ?? {}).length === 0;
  const fieldErrors = live.fieldErrors;
  const globalErrors = Object.entries(fieldErrors).filter(([k]) => !k.startsWith("folders.") && !k.startsWith("templates."));

  if (structure.isError) {
    return (
      <div className="space-y-4">
        <NestPageHeader nestName={nestName} onBack={onBack} />
        <Alert variant="destructive">
          <AlertTitle>Could not load this nest's structure rules</AlertTitle>
          <AlertDescription>{(structure.error as Error)?.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <NestPageHeader
        nestName={nestName}
        onBack={onBack}
        title={
          <h1 className="flex min-w-0 items-center gap-2 truncate text-xl font-semibold">
            <FolderTree className="h-5 w-5 shrink-0 text-muted-foreground" />
            Structure
          </h1>
        }
        badges={
          draft && (
            <Badge variant={enforced ? "success" : "secondary"} data-testid="structure-mode">
              {enforced ? "Enforced" : "Report only"}
            </Badge>
          )
        }
      >
        <Button variant="outline" size="sm" onClick={() => setYamlOpen(true)} disabled={!structure.data}>
          View YAML
        </Button>
        {canManage && (
          <Button size="sm" onClick={save} disabled={!dirty || saving} data-testid="structure-save">
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        )}
      </NestPageHeader>

      <p className="text-sm text-muted-foreground">
        The rules for <strong className="text-foreground">{nestName}</strong> — which folders can exist, what goes in
        them, how files are named, and which template new files start from. Each nest has its own; these apply here
        only.
      </p>

      {!canManage && structure.data && (
        <Alert>
          <AlertDescription>Rules are managed by the nest's owners and admins. You can see where things go, but not change the rules.</AlertDescription>
        </Alert>
      )}
      {structure.data?.error && (
        <Alert variant="destructive">
          <AlertTitle>The saved rules don't work</AlertTitle>
          <AlertDescription>{structure.data.error}</AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
      {globalErrors.map(([k, m]) => (
        <Alert key={k} variant="destructive">
          <AlertDescription>{m}</AlertDescription>
        </Alert>
      ))}
      {live.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Probably not what you meant</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {live.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {!draft ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <fieldset disabled={!canManage} className="m-0 flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border p-3">
            <label className="flex items-center gap-3">
              <Switch checked={enforced} onCheckedChange={toggleEnforce} aria-label="Enforce rules" />
              <span>
                <span className="block text-sm font-medium">Enforce rules</span>
                <span className="block text-xs text-muted-foreground">Off: rules only report. On: writes that break them are refused.</span>
              </span>
            </label>
            <label className="flex items-center gap-3">
              <Switch
                checked={!!draft.structure?.closed}
                onCheckedChange={(v) => setDraft(setSwitch(draft, "closed", v))}
                aria-label="Closed structure"
              />
              <span>
                <span className="block text-sm font-medium">Closed structure</span>
                <span className="block text-xs text-muted-foreground">Only folders with a rule (and their parents) may exist.</span>
              </span>
            </label>
            {dirty && (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="structure-unsaved">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Unsaved changes
              </span>
            )}
          </fieldset>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="blueprint">Blueprint</TabsTrigger>
              <TabsTrigger value="templates">Templates</TabsTrigger>
              <TabsTrigger value="compliance" className="gap-1.5">
                Compliance
                {violations && violations.length > 0 && (
                  <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{violations.length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="blueprint">
              {empty ? (
                <div className="space-y-3 rounded-lg border border-dashed p-8 text-center">
                  <FolderTree className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="font-medium">{nestName} has no structure rules yet</p>
                  <p className="mx-auto max-w-xl text-sm text-muted-foreground">
                    Anything can go anywhere. Rules decide which folders can exist, what goes in them, how files are
                    named, and which templates they start from — for this nest only.
                  </p>
                  {canManage && (
                    <form
                      className="mx-auto flex max-w-md gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        addRule();
                      }}
                    >
                      <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="clients/{client}" className="font-mono" aria-label="Folder path for the first rule" />
                      <Button type="submit" disabled={!adding.trim()}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        Add folder rule
                      </Button>
                    </form>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
                  <div className="space-y-1.5 rounded-lg border p-3">
                    <p className="px-1 pb-1 text-sm font-semibold">Folder rules</p>
                    {patterns.length === 0 && <p className="px-1 text-sm text-muted-foreground">No folder rules yet.</p>}
                    {patterns.map((p) => {
                      const r = folderRule(draft, p);
                      const depth = p.split("/").length - 1;
                      const badges = [
                        r.required && "required",
                        r.template,
                        r.types?.length && r.types.join(", "),
                        r.files && Object.keys(r.files).length && `${Object.keys(r.files).join(", ")} required`,
                      ].filter(Boolean) as string[];
                      const has = Object.keys(fieldErrors).some((k) => k.startsWith(`folders.${p}.`) || k === `folders.${p}`);
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setSelected(p)}
                          aria-pressed={p === current}
                          className={`w-full rounded-md border px-2.5 py-2 text-left ${
                            p === current ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-muted"
                          }`}
                          style={{ paddingLeft: `${10 + Math.min(depth, 4) * 12}px` }}
                        >
                          <span className={`block truncate font-mono text-sm ${has ? "text-destructive" : ""}`}>{p}</span>
                          {badges.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {badges.map((b) => (
                                <span key={b} className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{b}</span>
                              ))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {canManage && (
                      <form
                        className="flex gap-2 pt-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addRule();
                        }}
                      >
                        <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="decisions" className="h-8 font-mono" aria-label="New folder rule path" />
                        <Button type="submit" size="sm" variant="outline" disabled={!adding.trim()}>
                          <Plus className="h-4 w-4" />
                          <span className="sr-only">Add folder rule</span>
                        </Button>
                      </form>
                    )}
                  </div>
                  <fieldset disabled={!canManage} className="m-0 min-w-0 rounded-lg border p-4">
                    {current ? (
                      <RuleEditor
                        key={current}
                        nestId={nestId}
                        pattern={current}
                        rule={folderRule(draft, current)}
                        draft={draft}
                        canManage={canManage}
                        templates={Object.keys(draft.templates ?? {}).sort()}
                        types={structure.data?.types ?? []}
                        fieldErrors={fieldErrors}
                        onChange={(patch) => setDraft((d) => (d ? setFolder(d, current, patch) : d))}
                        onRename={(to) => {
                          const next = renameFolder(draft, current, to);
                          if (!next) {
                            toast.error(to ? `There is already a rule for ${to}.` : "A rule needs a folder path.");
                            return false;
                          }
                          setDraft(next);
                          setSelected(to);
                          return true;
                        }}
                        onRemove={() => {
                          setDraft(removeFolder(draft, current));
                          setSelected(null);
                        }}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Pick a folder rule on the left, or add one.</p>
                    )}
                  </fieldset>
                </div>
              )}
            </TabsContent>

            <TabsContent value="templates">
              <fieldset disabled={!canManage} className="m-0 min-w-0">
                <TemplatesTab
                  draft={draft}
                  setDraft={setDraft}
                  selected={selectedTemplate}
                  setSelected={setSelectedTemplate}
                  fieldErrors={fieldErrors}
                  canManage={canManage}
                />
              </fieldset>
            </TabsContent>

            <TabsContent value="compliance">
              <ComplianceTab
                nestName={nestName}
                violations={violations}
                loading={report.isLoading}
                dirty={dirty}
                openDocument={openDocument}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      <Dialog open={yamlOpen} onOpenChange={setYamlOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Saved rules for {nestName}</DialogTitle>
            <DialogDescription>
              From this nest's <code>.context/config.yaml</code>. Read-only here — the editor writes it for you.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {structure.data?.yaml || "# No structure rules saved for this nest yet."}
          </pre>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigator.clipboard
                  .writeText(structure.data?.yaml ?? "")
                  .then(() => toast.success("Copied"))
                  .catch(() => toast.error("Could not copy"))
              }
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enforce these rules in {nestName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm
                ? `${confirm} existing item${confirm === 1 ? "" : "s"} still don't fit. They stay readable and editable, but `
                : "Everything in this nest fits. From now on, "}
              new documents, moves and imports that break these rules will be refused for everyone: editors, agents and{" "}
              <code>ctx</code>. Save to apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (draft) setDraft(setSwitch(draft, "enforce", true));
                setConfirm(null);
              }}
            >
              Enforce rules
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

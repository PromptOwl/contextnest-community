/**
 * Structure — one nest's own rules: which folders can exist, what goes in
 * them, how files are named and which template they start from. Every nest
 * has its own; they live in that nest's vault, so `ctx`, agents and MCP
 * writes follow them too. Owners and admins edit; everyone else who works in
 * the nest reads them in words and can try names against them. Every verdict
 * comes from the server.
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
import { keys, reads } from "../../lib/queries";
import { setNavGuard, bypassNavGuard } from "../../lib/nav-guard";
import * as api from "../../lib/api";
import type { ApiError, StructureRules } from "../../lib/api";
import {
  describeMessage,
  folderPatterns,
  folderRule,
  placesOf,
  removeFolder,
  renameFolder,
  sameRules,
  setFolder,
  setSwitch,
  setTemplate,
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
  /** Show a folder in the nest's Documents view. */
  openFolder: (folder: string) => void;
  /** Open at the rule governing this folder, or start one for it. */
  initialFolder?: string;
}

interface Confirm {
  title: string;
  body: string;
  action: string;
  run: () => void;
}

export function StructurePage({ nestId, nestName, isArchived, onBack, openDocument, openFolder, initialFolder }: Props) {
  const qc = useQueryClient();
  const structure = useQuery(reads.structure(nestId));
  const report = useQuery(reads.structure(nestId, { report: true }));
  const saved = structure.data?.rules;

  // Owners and admins edit rules; writers can still fix what Compliance finds.
  // Until the nest read lands, the page is read-only rather than an editor
  // that may vanish.
  const [canManage, setCanManage] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    let ignore = false;
    qc.fetchQuery(reads.nest(nestId))
      .then((meta: any) => {
        if (ignore) return;
        const archived = isArchived || isNestArchived(meta?.nest);
        const caps = deriveNestCaps({
          roles: meta?.roles ?? [],
          permission: meta?.permission ?? null,
          myStewards: meta?.myStewards ?? [],
          isOwner: meta?.permission === "owner",
          isAdmin: meta?.permission === "admin",
          isArchived: archived,
        });
        setCanManage(caps.canManage && !archived);
        setCanEdit(caps.canEditDocs && !archived);
      })
      .catch(() => {
        if (!ignore) {
          setCanManage(false);
          setCanEdit(false);
        }
      });
    return () => {
      ignore = true;
    };
  }, [nestId, qc, isArchived]);

  // The draft of this nest's rules. Another nest is another draft.
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

  const dirty = canManage && !!draft && !!saved && !sameRules(draft, saved);
  const patterns = draft ? folderPatterns(draft) : [];
  const current = selected && draft?.folders?.[selected] !== undefined ? selected : patterns[0] ?? null;

  // Leaving with unsaved rules asks first — the app chrome, the sidebar,
  // another nest, or the browser itself.
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => {
    setNavGuard((proceed) => {
      if (!dirty) return false;
      setLeave(() => proceed);
      return true;
    });
    return () => setNavGuard(null);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ?folder= → that folder's rule; for an owner, a new rule when none covers it;
  // for everyone else, say so. Once.
  const folderHandled = useRef(false);
  const [uncovered, setUncovered] = useState<string | null>(null);
  useEffect(() => {
    if (!initialFolder || !draft || folderHandled.current) return;
    folderHandled.current = true;
    const p = initialFolder.replace(/^nodes\//, "");
    api
      .getStructure(nestId, { folder: initialFolder })
      .then((r) => {
        if (r.resolved && draft.folders?.[r.resolved.pattern] !== undefined) {
          setSelected(r.resolved.pattern);
        } else if (canManage) {
          setDraft((d) => (d && d.folders?.[p] === undefined ? setFolder(d, p, {}) : d));
          setSelected(p);
          toast.info(`No rule covers ${p}/ yet — this starts one. Save to keep it.`);
        } else {
          setUncovered(p);
        }
      })
      .catch(() => {});
  }, [initialFolder, draft, nestId, canManage]);

  // The server compiles the draft as it changes: problems show under the
  // field they name before anything is saved.
  const [live, setLive] = useState<{ fieldErrors: Record<string, string>; warnings: string[] }>({ fieldErrors: {}, warnings: [] });
  useEffect(() => {
    if (!draft || !dirty) {
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
  }, [draft, dirty, nestId, structure.data?.warnings]);

  // A save error describes the draft it was given: any edit makes it stale.
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => setSaveError(null), [draft]);

  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.saveStructure(nestId, draft);
      const fresh = await qc.fetchQuery(reads.structure(nestId));
      setDraft(fresh.rules);
      toast.success(
        `Structure rules saved for ${nestName}${r.violations ? ` — ${r.violations} existing problem${r.violations === 1 ? "" : "s"} to fix in Compliance` : ""}`,
      );
    } catch (e) {
      const err = e as ApiError;
      setSaveError(describeMessage(err.message));
      if (err.body?.fieldErrors) setLive((l) => ({ ...l, fieldErrors: err.body!.fieldErrors! }));
    } finally {
      setSaving(false);
    }
  };

  // Turning enforcement on is confirmed with what it would refuse today.
  const [enforceCount, setEnforceCount] = useState<{ problems: number; places: number } | null>(null);
  const toggleEnforce = async (on: boolean) => {
    if (!draft) return;
    if (!on) {
      setDraft(setSwitch(draft, "enforce", false));
      return;
    }
    try {
      const r = await api.checkStructure(nestId, { rules: setSwitch(draft, "enforce", true), report: true });
      if (r.error) {
        toast.error(`Fix the rules first: ${describeMessage(r.error)}`);
        return;
      }
      const v = r.report?.violations ?? [];
      setEnforceCount({ problems: v.length, places: placesOf(v) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const ask = (title: string, body: string, run: () => void, action = "Remove") => setConfirm({ title, body, action, run });

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
  const addTemplate = () => {
    if (!draft) return;
    let name = "template";
    for (let i = 2; draft.templates?.[name] !== undefined; i++) name = `template-${i}`;
    setDraft(setTemplate(draft, name, { body: "## Summary\n", required_sections: [] }));
    setSelectedTemplate(name);
    setTab("templates");
  };

  const removeRule = (p: string) => {
    if (!draft) return;
    const children = patterns.filter((x) => x.startsWith(`${p}/`));
    const run = () => {
      setDraft((d) => (d ? removeFolder(d, p) : d));
      setSelected(null);
    };
    if (children.length === 0) run();
    else ask(`Remove the rule for ${p}?`, `Its subfolder rules (${children.join(", ")}) stay, but nothing will require or name ${p}/ any more.`, run);
  };

  const [yamlOpen, setYamlOpen] = useState(false);
  const savedEnforced = !!saved?.structure?.enforce;
  const draftEnforced = !!draft?.structure?.enforce;
  const violations = report.data?.violations;
  const empty = !!draft && patterns.length === 0 && Object.keys(draft.templates ?? {}).length === 0;
  const fieldErrors = live.fieldErrors;
  const globalErrors = Object.entries(fieldErrors).filter(([k]) => !k.startsWith("folders.") && !k.startsWith("templates."));
  const templateSections = Object.fromEntries(
    Object.entries(draft?.templates ?? {}).map(([k, t]) => [k, t?.required_sections ?? []]),
  );
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.structure(nestId) });

  if (structure.isError) {
    return (
      <div className="space-y-4">
        <NestPageHeader nestName={nestName} onBack={onBack} />
        <Alert variant="destructive">
          <AlertTitle>Could not load the structure rules of {nestName}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{(structure.error as Error)?.message}</p>
            <Button variant="outline" size="sm" onClick={() => structure.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const saveButton = canManage && (
    <Button size="sm" onClick={save} disabled={!dirty || saving} data-testid="structure-save">
      {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
      Save
    </Button>
  );

  return (
    <div className="space-y-4 pb-16 sm:pb-0">
      <NestPageHeader
        nestName={nestName}
        onBack={onBack}
        title={
          <h1 className="flex min-w-0 items-center gap-2 truncate text-xl font-semibold">
            <FolderTree className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            Structure
          </h1>
        }
        badges={
          draft && (
            <>
              <Badge variant={savedEnforced ? "success" : "secondary"} data-testid="structure-mode">
                {savedEnforced ? "Enforced" : "Report only"}
              </Badge>
              {draftEnforced !== savedEnforced && (
                <Badge variant="warning">{draftEnforced ? "Enforced after Save" : "Report only after Save"}</Badge>
              )}
            </>
          )
        }
      >
        <Button variant="outline" size="sm" onClick={() => setYamlOpen(true)} disabled={!structure.data}>
          View YAML
        </Button>
        {saveButton}
      </NestPageHeader>

      <p className="text-sm text-muted-foreground">
        The rules for <strong className="text-foreground">{nestName}</strong> — which folders can exist, what goes in
        them, how files are named, and which template new files start from. Each nest has its own; these apply here
        only.
      </p>

      {!canManage && structure.data && (
        <Alert>
          <AlertDescription>
            Rules are managed by the nest's owners and admins. Here you can see where things go and try titles and
            folder names against them.
          </AlertDescription>
        </Alert>
      )}
      {uncovered && (
        <Alert>
          <AlertTitle>No rule covers {uncovered}/</AlertTitle>
          <AlertDescription>
            {draft?.structure?.closed
              ? "This nest's structure is closed: only the folders listed below may hold documents."
              : "Anything can go there; the rules below cover other folders."}
          </AlertDescription>
        </Alert>
      )}
      {structure.data?.error && (
        <Alert variant="destructive">
          <AlertTitle>The saved rules don't work</AlertTitle>
          <AlertDescription>{describeMessage(structure.data.error)}</AlertDescription>
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
          <AlertDescription>{describeMessage(`${k}: ${m}`)}</AlertDescription>
        </Alert>
      ))}
      {live.warnings.length > 0 && (
        <Alert variant="warning" className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <AlertTitle>Probably not what you meant</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {live.warnings.map((w) => (
                <li key={w}>{describeMessage(w)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {!draft ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading the structure rules">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <fieldset disabled={!canManage} className="m-0 flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border p-3">
            <legend className="sr-only">Enforcement</legend>
            <label className="flex items-center gap-3">
              <Switch checked={draftEnforced} onCheckedChange={toggleEnforce} aria-label="Enforce rules" />
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
              <span className="ml-auto flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300" data-testid="structure-unsaved" role="status">
                <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />
                Unsaved changes
              </span>
            )}
          </fieldset>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="blueprint">Blueprint</TabsTrigger>
              <TabsTrigger value="templates">Templates</TabsTrigger>
              <TabsTrigger value="compliance" className="gap-1.5">
                Compliance
                {violations && violations.length > 0 && (
                  <Badge variant="destructive" className="h-5 px-1.5 text-[10px]" aria-label={`${violations.length} problems`}>
                    {violations.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="blueprint">
              {empty ? (
                <div className="space-y-3 rounded-lg border border-dashed p-8 text-center">
                  <FolderTree className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
                  <p className="font-medium">{nestName} has no structure rules yet</p>
                  <p className="mx-auto max-w-xl text-sm text-muted-foreground">
                    Anything can go anywhere. Rules decide which folders can exist, what goes in them, how files are
                    named, and which templates they start from — for this nest only.
                  </p>
                  {canManage && (
                    <div className="mx-auto max-w-md space-y-2">
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addRule();
                        }}
                      >
                        <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="e.g. clients/{client}" className="font-mono" aria-label="Folder path for the first rule" />
                        <Button type="submit" disabled={!adding.trim()}>
                          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                          Add folder rule
                        </Button>
                      </form>
                      <Button variant="outline" size="sm" onClick={addTemplate}>
                        <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                        Add template
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
                  <nav aria-label="Folder rules" className="min-w-0 space-y-1.5 rounded-lg border p-3">
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
                          title={p}
                          onClick={() => setSelected(p)}
                          aria-current={p === current ? "true" : undefined}
                          className={`w-full rounded-md border px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-2 ${
                            p === current ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-muted"
                          }`}
                          style={{ paddingLeft: `${10 + Math.min(depth, 4) * 12}px` }}
                        >
                          <span className={`block break-all font-mono text-sm ${has ? "text-red-700 dark:text-red-400" : ""}`}>{p}</span>
                          {badges.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {badges.map((b) => (
                                <span key={b} className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                                  {b}
                                </span>
                              ))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {canManage && (
                      <form
                        className="space-y-1 pt-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          addRule();
                        }}
                      >
                        <label htmlFor="structure-add-rule" className="px-1 text-xs text-muted-foreground">
                          Add a rule for a folder path
                        </label>
                        <div className="flex gap-2">
                          <Input id="structure-add-rule" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="e.g. decisions" className="h-8 font-mono" />
                          <Button type="submit" size="sm" variant="outline" disabled={!adding.trim()}>
                            <Plus className="mr-1 h-4 w-4" aria-hidden />
                            Add
                          </Button>
                        </div>
                      </form>
                    )}
                  </nav>
                  <div className="min-w-0 rounded-lg border p-4">
                    {current ? (
                      <RuleEditor
                        key={current}
                        nestId={nestId}
                        pattern={current}
                        rule={folderRule(draft, current)}
                        templates={Object.keys(draft.templates ?? {}).sort()}
                        templateSections={templateSections}
                        types={structure.data?.types ?? []}
                        readOnly={!canManage}
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
                        onRemove={() => removeRule(current)}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Pick a folder rule, or add one.</p>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="templates">
              <fieldset disabled={!canManage} className="m-0 min-w-0">
                <legend className="sr-only">Templates</legend>
                <TemplatesTab
                  draft={draft}
                  setDraft={setDraft}
                  selected={selectedTemplate}
                  setSelected={setSelectedTemplate}
                  fieldErrors={fieldErrors}
                  canManage={canManage}
                  confirm={(title, body, run) => ask(title, body, run)}
                />
              </fieldset>
            </TabsContent>

            <TabsContent value="compliance">
              <ComplianceTab
                nestId={nestId}
                nestName={nestName}
                violations={violations}
                loading={report.isLoading}
                dirty={dirty}
                canEdit={canEdit}
                templates={structure.data?.templates ?? {}}
                openDocument={openDocument}
                openFolder={openFolder}
                onChanged={refresh}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* On a phone the header's Save is far from the editor. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t bg-background p-3 sm:hidden">
          <span className="text-sm">Unsaved changes</span>
          {saveButton}
        </div>
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
              <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={enforceCount !== null} onOpenChange={(o) => !o && setEnforceCount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enforce these rules in {nestName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {enforceCount && enforceCount.problems > 0
                ? `${enforceCount.problems} problem${enforceCount.problems === 1 ? "" : "s"} in ${enforceCount.places} existing place${enforceCount.places === 1 ? "" : "s"} won't change: that content stays readable and editable. But `
                : "Everything in this nest fits. From now on, "}
              new documents, edits, moves, new folders, deletes and imports that break these rules will be refused for
              everyone: editors, agents and the command line. Save to apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (draft) setDraft(setSwitch(draft, "enforce", true));
                setEnforceCount(null);
              }}
            >
              Enforce rules
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leave !== null} onOpenChange={(o) => !o && setLeave(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving your rule changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The changes to {nestName}'s structure rules haven't been saved and will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const go = leave;
                setLeave(null);
                if (go) bypassNavGuard(go);
              }}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Definitions — the nest's literal table-based ontology. Stewards/editors
 * define and articulate terms (existing #tags or brand-new vocabulary);
 * anything here is also pullable in real time via
 * GET /nests/:id/definitions?term=… (see the Connect docs).
 *
 * Writes are write-tier server-side (the nest middleware bumps non-GET here to
 * "write"), so a viewer — a read collaborator, a public reader, a share
 * grantee, or a steward without a write collaborator row — cannot define or
 * remove a term. They get the table read-only: no form, no row actions. The
 * page used to render the whole editor for them and answer with a toast on
 * save, which offered an action that was never theirs to take.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Pencil, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NestPageHeader } from "./NestPageHeader";
import { deriveNestCaps } from "../lib/nest-caps";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import type { Definition } from "../lib/api";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

export function DefinitionsPage({ nestId, nestName, onBack }: Props) {
  const [rows, setRows] = useState<Definition[]>([]);
  const qc = useQueryClient();
  const [loading, setLoading] = useState(true);
  // Write-tier only — matches the server gate exactly. Derived from the same
  // nest read every other nest screen uses, so the rule lives in nest-caps
  // rather than being guessed again here. Defaults to false: until the nest
  // read lands, show the read-only view rather than an editor that may vanish.
  const [canWrite, setCanWrite] = useState(false);
  const [saving, setSaving] = useState(false);
  // One shared form for add + edit; editingId null = adding. The id is sent
  // as editing_id on save so a rename replaces that exact row server-side
  // (and 409s if the new name already belongs to another row) — no
  // client-side delete-the-old dance.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [linkedTag, setLinkedTag] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { definitions } = await qc.fetchQuery(reads.definitions(nestId));
      setRows(definitions);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load definitions");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    // Guarded: this page is rendered without a key, so nestId can change while
    // it stays mounted. A slow response for the previous nest must not land
    // after the effect re-ran and grant (or withhold) the wrong nest's
    // affordances.
    let ignore = false;
    // Cached alongside the nest screens, so this is usually free.
    qc.fetchQuery(reads.nest(nestId))
      .then((meta: any) => {
        if (ignore) return;
        const caps = deriveNestCaps({
          roles: meta?.roles ?? [],
          permission: meta?.permission ?? null,
          myStewards: meta?.myStewards ?? [],
          isOwner: meta?.permission === "owner",
          isAdmin: meta?.permission === "admin",
        });
        // Definitions sit at write-tier, NOT the looser canEditDocs: the
        // steward-editor bypass in app.ts covers /nodes routes only, so a
        // nest-scope editor steward without a write collaborator row is
        // refused here by the server too.
        setCanWrite(caps.canManage || caps.collabCanWrite);
      })
      .catch(() => {
        if (!ignore) setCanWrite(false);
      });
    return () => {
      ignore = true;
    };
  }, [nestId, qc]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setTerm("");
    setDefinition("");
    setLinkedTag("");
  };

  const startEdit = (d: Definition) => {
    setEditingId(d.id);
    setTerm(d.term);
    setDefinition(d.definition);
    setLinkedTag(d.linked_tag?.replace(/^#/, "") ?? "");
  };

  // A term the nest already defines. The POST upserts by term, so typing an
  // existing one in the add form is an overwrite of a teammate's wording, not
  // an add — surface it before the click rather than after. In edit mode the
  // match is a *sibling* row (self excluded), which the server 409s.
  const typedTerm = term.trim().toLowerCase();
  const existing =
    typedTerm
      ? rows.find(
          (r) => r.term.toLowerCase() === typedTerm && r.id !== editingId,
        ) ?? null
      : null;

  const save = async () => {
    if (!term.trim() || !definition.trim()) {
      toast.error("Term and definition are both required.");
      return;
    }
    setSaving(true);
    try {
      // linked_tag: the server leaves it unchanged when the key is omitted and
      // clears it on an explicit null. In edit mode the field is prefilled, so
      // an empty box means "remove this tag". In the add form it was never
      // filled in, so an empty box means "I didn't say" — omitting it keeps the
      // tag a replaced definition already had instead of silently dropping it.
      const tag = linkedTag.trim();
      await api.upsertDefinition(nestId, {
        term: term.trim(),
        definition: definition.trim(),
        ...(tag || editingId ? { linked_tag: tag || null } : {}),
        // Scope the write to the opened row so a rename replaces it in place
        // (server 409s if the new term already belongs to another row).
        ...(editingId ? { editing_id: editingId } : {}),
      });
      toast.success(
        editingId
          ? "Definition updated"
          : existing
            ? `Replaced the definition of "${existing.term}"`
            : "Term defined",
      );
      resetForm();
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (d: Definition) => {
    try {
      await api.deleteDefinition(nestId, d.id);
      toast.success(`Removed "${d.term}"`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <NestPageHeader nestName={nestName} onBack={onBack} />

      <p className="text-sm text-muted-foreground">
        The nest's shared vocabulary — what each term means here, written down
        once so everyone (and every agent reading this nest) uses it the same
        way.
      </p>

      {/* The endpoint is real and worth having, but it belongs behind a
          disclosure: most people opening this page are writing a definition,
          not calling an API. */}
      <details className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">
          For developers — fetch a definition over HTTP
        </summary>
        <div className="mt-2 space-y-1.5 text-muted-foreground">
          <p>
            Agents and analysis jobs read these live, so a definition edited
            here changes what they answer with on the next call.
          </p>
          <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-[10.5px] leading-relaxed">
            GET /nests/{nestId}/definitions?term=&lt;term&gt;
          </pre>
          <p>Omit the query to get the whole glossary.</p>
        </div>
      </details>

      {/* Add / edit form — write-tier only. */}
      {canWrite && (
      <div className="border border-border rounded-lg bg-card p-3 space-y-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder='Term — e.g. "CAC" or an existing tag name'
          />
          <Input
            value={linkedTag}
            onChange={(e) => setLinkedTag(e.target.value)}
            placeholder="Linked tag (optional) — e.g. gtm"
          />
        </div>
        <textarea
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          placeholder="Definition — articulate exactly what this term means here, including formula/source if quantitative."
          className="w-full min-h-[72px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {existing && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <b>{existing.term}</b>{" "}
                {editingId ? (
                  <>
                    is already defined by another entry ({existing.defined_by}) —
                    saving this rename will be rejected.
                  </>
                ) : (
                  <>
                    is already defined by {existing.defined_by}. Saving replaces
                    that definition:
                  </>
                )}
                <div className="mt-1 whitespace-pre-wrap text-amber-900/80">
                  {existing.definition.length > 240
                    ? `${existing.definition.slice(0, 240)}…`
                    : existing.definition}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => startEdit(existing)}
              >
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit it instead
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {editingId && (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : editingId ? (
              <>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Update
              </>
            ) : existing ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Replace definition
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" /> Define term
              </>
            )}
          </Button>
        </div>
      </div>
      )}

      {/* The ontology table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Term</th>
              <th>Definition</th>
              <th>Tag</th>
              <th>Defined by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  {canWrite
                    ? "No terms defined yet. Give your nest a shared vocabulary."
                    : "No terms defined yet."}
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className="border-t border-border align-top [&>td]:px-3 [&>td]:py-2">
                <td className="font-medium whitespace-nowrap">{d.term}</td>
                <td className="max-w-[420px]">
                  <span className="whitespace-pre-wrap">{d.definition}</span>
                </td>
                <td className="whitespace-nowrap">
                  {d.linked_tag ? (
                    <span className="rounded bg-amber-50 text-amber-700 px-1.5 py-0.5 text-xs">
                      {d.linked_tag}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-xs text-muted-foreground whitespace-nowrap">
                  {d.defined_by}
                </td>
                <td className="whitespace-nowrap text-right">
                  {canWrite && (
                    <>
                      <button
                        type="button"
                        aria-label={`Edit ${d.term}`}
                        onClick={() => startEdit(d)}
                        className="p-1 rounded hover:bg-accent mr-1"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${d.term}`}
                        onClick={() => remove(d)}
                        className="p-1 rounded hover:bg-accent text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

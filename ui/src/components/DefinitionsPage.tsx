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
import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Loader2, Plus, Trash2, Pencil, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NestPageHeader } from "./NestPageHeader";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import type { Definition } from "../lib/api";

interface Props {
  nestId: string;
  nestName: string;
  /** Nest is archived — opened from the Archived section, forces read-only. */
  isArchived?: boolean;
  onBack: () => void;
}

export function DefinitionsPage({ nestId, nestName, isArchived, onBack }: Props) {
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
          // OR'd with the fetched nest itself, not just the isArchived prop
          // threaded down from App's View state — this page is also
          // reachable by a route that doesn't forward it (a deep link, a
          // refresh while already here), and this same fetch already has the
          // authoritative answer regardless of how we got here.
          isArchived: isArchived || isNestArchived(meta?.nest),
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
  }, [nestId, qc, isArchived]);

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

  /** Resolves true when the row was written — a failed save keeps the row
   *  open with what was typed. */
  const save = async (): Promise<boolean> => {
    if (!term.trim() || !definition.trim()) {
      toast.error("Term and definition are both required.");
      return false;
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
      return true;
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
      return false;
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

  // Which row is open for editing: an existing row's id, "new" for the add
  // row at the bottom, or null. One set of fields serves both.
  const [adding, setAdding] = useState(false);
  const editingRow = editingId ?? (adding ? "new" : null);
  const closeRow = () => {
    resetForm();
    setAdding(false);
  };
  const onFieldKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeRow();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || !(e.target instanceof HTMLTextAreaElement))) {
      e.preventDefault();
      void save().then((ok) => ok && setAdding(false));
    }
  };
  const fieldClass =
    "w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  /** The editable cells — the row itself is the form (Notion-style). */
  const editCells = (
    <>
      <td className="align-top">
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder="Term"
          aria-label="Term"
          className={fieldClass}
          data-testid="definitions-term"
        />
      </td>
      <td className="align-top">
        <textarea
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder="What this term means here — formula or source if quantitative. Ctrl+Enter saves."
          aria-label="Definition"
          rows={Math.min(8, Math.max(2, definition.split("\n").length + 1))}
          className={`${fieldClass} min-h-[2.25rem] resize-y`}
          data-testid="definitions-definition"
        />
      </td>
      <td className="align-top">
        <input
          value={linkedTag}
          onChange={(e) => setLinkedTag(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder="tag"
          aria-label="Linked tag"
          className={`${fieldClass} w-28`}
          data-testid="definitions-tag"
        />
      </td>
      <td className="align-top text-xs text-muted-foreground whitespace-nowrap pt-2">
        {editingId ? rows.find((r) => r.id === editingId)?.defined_by : "you"}
      </td>
      <td className="align-top whitespace-nowrap text-right">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" className="h-7" onClick={closeRow} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7"
            onClick={() => void save().then((ok) => ok && setAdding(false))}
            disabled={saving || !term.trim() || !definition.trim()}
            data-testid="definitions-save"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : existing && !editingId ? (
              "Replace"
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </td>
    </>
  );

  return (
    <div className="space-y-4">
      <NestPageHeader
        nestName={nestName}
        onBack={onBack}
        title={
          <h1 className="min-w-0 truncate text-xl font-semibold">Definitions</h1>
        }
      />

      <p className="text-sm text-muted-foreground">
        The nest's shared vocabulary — what each term means here, written down
        once so everyone (and every agent reading this nest) uses it the same
        way. Click a row to edit it.
      </p>

      {/* The table IS the editor: rows edit in place, a new term is the last
          row. No form above it. */}
      <div className="border border-border rounded-lg overflow-x-auto" data-testid="definitions-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th className="w-[18%]">Term</th>
              <th>Definition</th>
              <th className="w-28">Tag</th>
              <th className="w-36">Defined by</th>
              <th className="w-28"></th>
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
            {!loading && rows.length === 0 && !adding && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  {canWrite
                    ? "No terms defined yet. Add the first one below."
                    : "No terms defined yet."}
                </td>
              </tr>
            )}
            {rows.map((d) =>
              editingRow === d.id ? (
                <tr
                  key={d.id}
                  className="border-t border-border bg-muted/20 [&>td]:px-2 [&>td]:py-1.5"
                  data-testid="definitions-row-editing"
                >
                  {editCells}
                </tr>
              ) : (
                <tr
                  key={d.id}
                  onClick={canWrite && editingRow === null ? () => startEdit(d) : undefined}
                  className={`group border-t border-border align-top [&>td]:px-3 [&>td]:py-2${
                    canWrite && editingRow === null ? " cursor-text hover:bg-muted/30" : ""
                  }`}
                  data-testid="definitions-row"
                >
                  <td className="font-medium whitespace-nowrap">{d.term}</td>
                  <td className="max-w-[520px]">
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
                      <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label={`Edit ${d.term}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(d);
                          }}
                          className="p-1 rounded hover:bg-accent mr-1"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${d.term}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(d);
                          }}
                          className="p-1 rounded hover:bg-accent text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ),
            )}
            {/* The duplicate-term warning sits under whichever row is open. */}
            {editingRow !== null && existing && (
              <tr className="bg-amber-50/60">
                <td colSpan={5} className="px-3 py-2 text-xs text-amber-800">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <b>{existing.term}</b>{" "}
                      {editingId ? (
                        <>is already defined by another row ({existing.defined_by}) — this rename will be rejected.</>
                      ) : (
                        <>is already defined by {existing.defined_by}. Saving replaces that definition.</>
                      )}
                    </div>
                    {!editingId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0"
                        onClick={() => {
                          setAdding(false);
                          startEdit(existing);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit it instead
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {canWrite && adding && editingId === null && (
              <tr
                className="border-t border-border bg-muted/20 [&>td]:px-2 [&>td]:py-1.5"
                data-testid="definitions-row-new"
              >
                {editCells}
              </tr>
            )}
            {canWrite && !adding && (
              <tr className="border-t border-border">
                <td colSpan={5} className="p-0">
                  <button
                    type="button"
                    onClick={() => {
                      resetForm();
                      setAdding(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    data-testid="definitions-add"
                  >
                    <Plus className="h-3.5 w-3.5" /> New term
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
    </div>
  );
}

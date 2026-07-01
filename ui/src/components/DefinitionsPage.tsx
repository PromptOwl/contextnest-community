/**
 * Definitions — the nest's literal table-based ontology. Stewards/editors
 * define and articulate terms (existing #tags or brand-new vocabulary);
 * anything here is also pullable in real time via
 * GET /nests/:id/definitions?term=… (see the Connect docs).
 *
 * Writes are server-gated to write-tier; read-only viewers see the table
 * and get a toast if they try to edit.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BookMarked, Loader2, Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "../lib/api";
import type { Definition } from "../lib/api";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

export function DefinitionsPage({ nestId, nestName, onBack }: Props) {
  const [rows, setRows] = useState<Definition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // One shared form for add + edit; editingId null = adding. The original
  // term is kept so renaming during an edit replaces the old row (the
  // backend upserts by term text, so a rename would otherwise duplicate).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTerm, setEditingTerm] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [linkedTag, setLinkedTag] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { definitions } = await api.listDefinitions(nestId);
      setRows(definitions);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load definitions");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setEditingTerm(null);
    setTerm("");
    setDefinition("");
    setLinkedTag("");
  };

  const startEdit = (d: Definition) => {
    setEditingId(d.id);
    setEditingTerm(d.term);
    setTerm(d.term);
    setDefinition(d.definition);
    setLinkedTag(d.linked_tag?.replace(/^#/, "") ?? "");
  };

  const save = async () => {
    if (!term.trim() || !definition.trim()) {
      toast.error("Term and definition are both required.");
      return;
    }
    setSaving(true);
    try {
      await api.upsertDefinition(nestId, {
        term: term.trim(),
        definition: definition.trim(),
        linked_tag: linkedTag.trim() || null,
      });
      // Renamed during edit → the upsert created a NEW row; remove the old
      // one so this is a rename, not a duplicate.
      if (
        editingId &&
        editingTerm &&
        term.trim().toLowerCase() !== editingTerm.toLowerCase()
      ) {
        await api.deleteDefinition(nestId, editingId);
      }
      toast.success(editingId ? "Definition updated" : "Term defined");
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
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-muted-foreground" />
          Definitions · {nestName}
        </h1>
      </div>

      <p className="text-sm text-muted-foreground">
        The nest's shared vocabulary — terms and tags, articulated once,
        pulled anywhere. Agents and analysis jobs fetch these live:{" "}
        <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
          GET /nests/{nestId.slice(0, 8)}…/definitions?term=&lt;term&gt;
        </code>
      </p>

      {/* Add / edit form */}
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
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" /> Define term
              </>
            )}
          </Button>
        </div>
      </div>

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
                  No terms defined yet. Give your nest a shared vocabulary.
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

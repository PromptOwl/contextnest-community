/**
 * Edge types — the "turing" workflow plane's vocabulary of connections.
 * Stewards articulate once what a relation MEANS (`next`, `escalates-when`,
 * …); edges reference the registry. The definitions-table move, applied to
 * relations.
 *
 * Feature-flagged: the whole plane (and this page's nav entry) only appears
 * when the "Workflow plane" admin toggle is on. Writes are server-gated to
 * write-tier; read-only viewers see the table and get a toast if they edit.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Workflow, Loader2, Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "../lib/api";
import type { EdgeType, EdgeTypeCondition } from "../lib/api";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

type Mode = EdgeTypeCondition["mode_default"];
const MODES: Array<{ value: Mode; label: string }> = [
  { value: "structured", label: "Structured (typed params)" },
  { value: "nl", label: "Natural language" },
  { value: "open", label: "Open / freeform" },
];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function EdgeTypesPage({ nestId, nestName, onBack }: Props) {
  const [rows, setRows] = useState<EdgeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // One shared form for add + edit. Editing keeps the name locked: the server
  // upserts by name, so a "rename" would mint a new row and orphan the old —
  // to rename you delete and recreate.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<EdgeType["direction"]>("directed");
  const [isFlow, setIsFlow] = useState(false);
  const [color, setColor] = useState<string>(""); // "" = none
  const [conditionParams, setConditionParams] = useState("");
  const [conditionMode, setConditionMode] = useState<Mode>("structured");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { edge_types } = await api.listEdgeTypes(nestId);
      setRows(edge_types);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load edge types");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setDirection("directed");
    setIsFlow(false);
    setColor("");
    setConditionParams("");
    setConditionMode("structured");
  };

  const startEdit = (t: EdgeType) => {
    setEditingId(t.id);
    setName(t.name);
    setDescription(t.description);
    setDirection(t.direction);
    setIsFlow(t.is_flow);
    setColor(t.color ?? "");
    setConditionParams(t.condition_schema?.params.join(", ") ?? "");
    setConditionMode(t.condition_schema?.mode_default ?? "structured");
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !description.trim()) {
      toast.error("Name and description are both required.");
      return;
    }
    if (!NAME_RE.test(trimmedName)) {
      toast.error("Name must be alphanumeric with dashes, e.g. escalates-when");
      return;
    }
    const params = conditionParams
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await api.upsertEdgeType(nestId, {
        name: trimmedName,
        description: description.trim(),
        direction,
        is_flow: isFlow,
        color: color.trim() || null,
        condition_schema: params.length
          ? { params, mode_default: conditionMode }
          : null,
      });
      toast.success(editingId ? "Edge type updated" : `Defined "${trimmedName}"`);
      resetForm();
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: EdgeType) => {
    try {
      await api.deleteEdgeType(nestId, t.id);
      toast.success(`Removed "${t.name}"`);
      await load();
    } catch (e: any) {
      // Server 400s while edges still reference the type; surface that verbatim.
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
          <Workflow className="h-4 w-4 text-muted-foreground" />
          Edge Types · {nestName}
        </h1>
      </div>

      <p className="text-sm text-muted-foreground">
        The vocabulary of connections in this nest — each relation articulated
        once, then referenced by edges.{" "}
        <span className="text-foreground">Flow</span> types form the workflow
        DAG; the rest capture lineage or ownership. Fetch them live:{" "}
        <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
          GET /nests/{nestId.slice(0, 8)}…/edge-types
        </code>
      </p>

      {/* Add / edit form */}
      <div className="border border-border rounded-lg bg-card p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <div className="space-y-1">
            <Label htmlFor="et-name" className="text-xs">
              Name
            </Label>
            <Input
              id="et-name"
              value={name}
              disabled={!!editingId}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. escalates-when"
            />
            {editingId && (
              <p className="text-[11px] text-muted-foreground">
                Name is the identity — delete and recreate to rename.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="et-direction" className="text-xs">
              Direction
            </Label>
            <Select
              value={direction}
              onValueChange={(v) => setDirection(v as EdgeType["direction"])}
            >
              <SelectTrigger id="et-direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="directed">Directed (→)</SelectItem>
                <SelectItem value="undirected">Undirected (—)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="et-desc" className="text-xs">
            Description
          </Label>
          <Textarea
            id="et-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Articulate exactly what this connection means here."
            className="min-h-[64px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Switch id="et-flow" checked={isFlow} onCheckedChange={setIsFlow} />
            <Label htmlFor="et-flow" className="text-sm font-normal cursor-pointer">
              Flow type
              <span className="text-muted-foreground"> — part of the DAG</span>
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Color</span>
            <input
              type="color"
              value={color || "#3b82f6"}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-9 rounded border border-input bg-transparent p-0.5 cursor-pointer"
              aria-label="Edge type color"
            />
            {color ? (
              <button
                type="button"
                onClick={() => setColor("")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">No color</span>
            )}
          </div>
        </div>

        {/* Optional condition template — makes the edge type conditional. */}
        <div className="grid gap-3 sm:grid-cols-[1fr_220px] pt-1">
          <div className="space-y-1">
            <Label htmlFor="et-params" className="text-xs">
              Condition params{" "}
              <span className="text-muted-foreground font-normal">
                (optional, comma-separated)
              </span>
            </Label>
            <Input
              id="et-params"
              value={conditionParams}
              onChange={(e) => setConditionParams(e.target.value)}
              placeholder="e.g. term, op, value"
            />
          </div>
          {conditionParams.trim() && (
            <div className="space-y-1">
              <Label htmlFor="et-mode" className="text-xs">
                Default mode
              </Label>
              <Select
                value={conditionMode}
                onValueChange={(v) => setConditionMode(v as Mode)}
              >
                <SelectTrigger id="et-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
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
                <Plus className="h-3.5 w-3.5 mr-1" /> Define edge type
              </>
            )}
          </Button>
        </div>
      </div>

      {/* The registry table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Type</th>
              <th>Direction</th>
              <th>Flow</th>
              <th>Condition</th>
              <th>Created by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No edge types yet. Define the vocabulary your workflow will use.
                </td>
              </tr>
            )}
            {rows.map((t) => (
              <tr
                key={t.id}
                className="border-t border-border align-top [&>td]:px-3 [&>td]:py-2"
              >
                <td className="max-w-[360px]">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0 border border-black/10"
                      style={{ background: t.color ?? "transparent" }}
                      aria-hidden
                    />
                    <span className="font-mono font-medium">{t.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-0.5 pl-[18px]">
                    {t.description}
                  </p>
                </td>
                <td className="whitespace-nowrap">
                  <Badge variant={t.direction === "directed" ? "info" : "neutral"}>
                    {t.direction === "directed" ? "Directed" : "Undirected"}
                  </Badge>
                </td>
                <td className="whitespace-nowrap">
                  {t.is_flow ? (
                    <Badge variant="success">Flow</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="max-w-[220px]">
                  {t.condition_schema ? (
                    <div className="flex flex-wrap items-center gap-1">
                      {t.condition_schema.params.map((p) => (
                        <span
                          key={p}
                          className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono"
                        >
                          {p}
                        </span>
                      ))}
                      <span className="text-[11px] text-muted-foreground">
                        · {t.condition_schema.mode_default}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-xs text-muted-foreground whitespace-nowrap">
                  {t.created_by}
                </td>
                <td className="whitespace-nowrap text-right">
                  <button
                    type="button"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => startEdit(t)}
                    className="p-1 rounded hover:bg-accent mr-1"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => remove(t)}
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

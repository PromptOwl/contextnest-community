/**
 * NodeFieldsPanel — the nest's custom fields on an open document, as a
 * property list (label left, value right), Notion/Linear-style.
 *
 * Each value saves on its own (PATCH { fields: { key: value } }) rather than
 * riding the editor's Save: a field is a property of the document, like a
 * board move, and must not wait behind an unsaved body. The PATCH seals a
 * version like any edit, so the panel hands the new node back and the editor
 * picks up its version — otherwise the next body save would trip the
 * X-Base-Version conflict check against our own write.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import * as api from "../../lib/api";
import { reads } from "../../lib/queries";
import { applicableFields, isComputed } from "../../lib/custom-fields";
import { FieldValueEditor } from "./FieldParts";

interface Props {
  nestId: string;
  nodeId: string;
  nodeType: string | null;
  fields: Record<string, unknown> | undefined;
  statusSince?: string;
  canEdit: boolean;
  /** The saved node, so the editor can take its version / status. */
  onSaved: (node: any) => void;
  /** Open the nest's Fields admin (shown when no fields apply yet). */
  onManageFields?: () => void;
}

export function NodeFieldsPanel({
  nestId,
  nodeId,
  nodeType,
  fields,
  statusSince,
  canEdit,
  onSaved,
  onManageFields,
}: Props) {
  const defsQuery = useQuery({ ...reads.fields(nestId), enabled: !!nestId });
  const defs = useMemo(
    () => applicableFields(defsQuery.data?.fields ?? [], nodeType ?? "document"),
    [defsQuery.data, nodeType],
  );
  const { data: roster } = useQuery({ ...reads.mentionable(nestId), enabled: !!nestId && canEdit });
  const people = useMemo(
    () => (roster?.people ?? []).filter((p: any) => !!p.email) as Array<{ email: string; name: string | null; member?: boolean }>,
    [roster],
  );
  const personLabel = (email: string) =>
    people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name || email;

  const [values, setValues] = useState<Record<string, unknown>>(fields ?? {});
  useEffect(() => setValues(fields ?? {}), [fields]);
  const [saving, setSaving] = useState<string | null>(null);
  // Time in status ticks while the document is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!defs.some(isComputed)) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [defs]);

  if (defs.length === 0) {
    if (!onManageFields || !defsQuery.data?.can_manage || nodeType !== "task") return null;
    return (
      <button
        type="button"
        onClick={onManageFields}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Add custom fields to this nest's tasks
      </button>
    );
  }

  async function commit(key: string, next: unknown) {
    const prev = values;
    setValues((v) => {
      const out = { ...v };
      if (next === null) delete out[key];
      else out[key] = next;
      return out;
    });
    setSaving(key);
    try {
      const res: any = await api.updateNode(nestId, nodeId, { fields: { [key]: next } });
      if (res?.node) {
        setValues(res.node.fields ?? {});
        onSaved(res.node);
      }
    } catch (e: any) {
      setValues(prev);
      toast.error(e?.message || "Couldn't save the field");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section
      className="w-full rounded-lg border bg-card/40 px-3 py-2"
      aria-label="Fields"
      data-testid="node-fields-panel"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Fields
        </span>
        {onManageFields && defsQuery.data?.can_manage && (
          <button
            type="button"
            onClick={onManageFields}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Manage
          </button>
        )}
      </div>
      <dl className="grid grid-cols-[minmax(7rem,10rem)_1fr] items-center gap-x-3 gap-y-0.5">
        {defs.map((def) => (
          <div key={def.key} className="contents">
            <dt className="truncate text-sm text-muted-foreground" title={def.key}>
              {def.label}
              {def.required && <span className="ml-0.5 text-muted-foreground/70">*</span>}
            </dt>
            <dd className={saving === def.key ? "opacity-60" : ""}>
              <FieldValueEditor
                def={def}
                value={values[def.key]}
                node={{ status_since: statusSince, fields: values }}
                now={now}
                people={people}
                personLabel={personLabel}
                disabled={!canEdit || saving !== null}
                onCommit={(next) => void commit(def.key, next)}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

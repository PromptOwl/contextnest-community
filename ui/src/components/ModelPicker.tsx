/**
 * One of the models this server's key can reach (PromptOwl's team models on the
 * gateway, the provider's on an own key), grouped, with "your key" marked. If
 * the list can't be loaded, a name can still be typed.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { getAdminModels } from "@/lib/api";
import { modelOptions } from "@/lib/model-options";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/SearchableSelect";

export function ModelPicker({
  id,
  testId,
  value,
  onChange,
  error,
  disabled,
  nestId,
  reloadKey,
  hint,
}: {
  id: string;
  testId?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
  /** List what this nest's calls can reach (its own key comes first). */
  nestId?: string | null;
  /** Changes when the own-provider keys change, so the list is fetched again. */
  reloadKey?: string;
  /** The line under the field; `count` is 0 when the list couldn't be loaded. */
  hint: (count: number) => string;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [own, setOwn] = useState<string[]>([]);
  const [providers, setProviders] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    getAdminModels(nestId)
      .then((r) => {
        if (!live) return;
        setModels(r.models);
        setOwn(r.own_models ?? []);
        setProviders(r.providers ?? {});
      })
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [nestId, reloadKey]);
  const options = useMemo(() => modelOptions(models ?? [], own, providers, value), [models, own, providers, value]);
  return (
    <>
      {models === null ? (
        <div className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
        </div>
      ) : models.length > 0 ? (
        <SearchableSelect
          id={id}
          testId={testId}
          value={value}
          onChange={onChange}
          options={options}
          disabled={disabled}
          placeholder="Pick a model"
          searchPlaceholder="Search models…"
          emptyText="No model matches."
        />
      ) : (
        <Input id={id} value={value} placeholder="claude-sonnet-5" disabled={disabled} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {models !== null && <p className="text-xs text-muted-foreground">{hint(models.length)}</p>}
    </>
  );
}

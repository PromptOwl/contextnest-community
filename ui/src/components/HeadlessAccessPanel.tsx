/**
 * HeadlessAccessPanel — "API-only access" for a nest (CU-wdqcq0314u).
 *
 * Publishing a nest headless hands it out as read-only ACCESS KEYS: a buyer
 * uses the key with ctx or any MCP client to list, get, query and search the
 * nest's approved documents, and can never open, browse, export or edit it.
 * Each key is its own identity, labeled with who it's for and revocable on
 * its own; turning publishing off pauses every key.
 *
 * Owner / nest admin only (the host renders it behind canManage; the server
 * enforces the admin tier regardless). Self-fetches, like
 * NestVisibilityControl, and reports failures through `onError`.
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as api from "../lib/api";
import { useNestMeta } from "../lib/queries";
import {
  MAX_KEY_LABEL,
  connectSnippet,
  headlessToggleBlockReason,
  keyLastUsedLabel,
  sharedSeatsNote,
  validateKeyLabel,
} from "../lib/headless";

interface Props {
  nestId: string;
  onError?: (message: string) => void;
}

export function HeadlessAccessPanel({ nestId, onError }: Props) {
  const meta = useNestMeta(nestId);
  const visibility = (meta.data as any)?.nest?.visibility as string | undefined;
  const [enabled, setEnabled] = useState(false);
  const [keys, setKeys] = useState<api.HeadlessKey[]>([]);
  const [seats, setSeats] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  // The token of the key just minted — shown once, cleared on dismiss.
  const [fresh, setFresh] = useState<{ label: string; apiKey: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getNestHeadless(nestId);
      setEnabled(res.enabled);
      setKeys(res.keys);
      setSeats(sharedSeatsNote(res.shared_with));
    } catch (err: any) {
      onError?.(err?.message || "Couldn't load API-only access");
    } finally {
      setLoaded(true);
    }
  }, [nestId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const blocked = headlessToggleBlockReason(visibility, enabled);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const res = await api.setNestHeadless(nestId, next);
      setEnabled(res.enabled);
    } catch (err: any) {
      onError?.(err?.message || "Couldn't change API-only publishing");
    } finally {
      setBusy(false);
    }
  }

  async function mint() {
    const problem = validateKeyLabel(label);
    if (problem) return onError?.(problem);
    setBusy(true);
    try {
      const res = await api.mintNestHeadlessKey(nestId, label.trim());
      setFresh({ label: res.key.label, apiKey: res.api_key });
      setLabel("");
      await load();
    } catch (err: any) {
      onError?.(err?.message || "Couldn't create the key");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: api.HeadlessKey) {
    if (!window.confirm(`Revoke "${key.label}"? Anything using this key stops working immediately.`)) return;
    setBusy(true);
    try {
      await api.revokeNestHeadlessKey(nestId, key.id);
      await load();
    } catch (err: any) {
      onError?.(err?.message || "Couldn't revoke the key");
    } finally {
      setBusy(false);
    }
  }

  const snippet = fresh ? connectSnippet(window.location.origin, nestId, fresh.apiKey) : "";

  return (
    <div className="rounded-lg border p-4 space-y-3" data-testid="headless-access-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="headless-switch" className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4" /> API-only access
          </Label>
          <p className="text-xs text-muted-foreground">
            Hand out read-only keys that work with ctx or any MCP client. Key holders can list,
            read and search this nest's approved documents in their own workflows, but can never
            open, browse, export or edit the nest, or see drafts.
          </p>
          {blocked && <p className="text-xs text-amber-600">{blocked}</p>}
          {seats && <p className="text-xs text-muted-foreground">{seats}</p>}
        </div>
        <Switch
          id="headless-switch"
          checked={enabled}
          disabled={!loaded || busy || (!!blocked && !enabled)}
          onCheckedChange={(v) => void toggle(v)}
        />
      </div>

      {enabled && (
        <>
          <p className="text-xs text-muted-foreground">
            Approved documents are readable through the API, one at a time — this stops browsing
            and bulk export, not a determined key holder reading what you've published.
          </p>
          <div className="flex gap-2">
            <Input
              value={label}
              maxLength={MAX_KEY_LABEL}
              placeholder="Who is this key for? e.g. Acme Corp"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void mint()}
              disabled={busy}
            />
            <Button onClick={() => void mint()} disabled={busy || !label.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create key"}
            </Button>
          </div>
        </>
      )}

      {fresh && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 text-xs dark:bg-amber-950/30">
          <p className="font-medium">
            Key for {fresh.label} — copy it now. It won't be shown again.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">{snippet}</pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(snippet)}
            >
              <Copy className="mr-1 h-3 w-3" /> Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{k.label}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{k.key_prefix}…</span> · {keyLastUsedLabel(k.last_used_at)}
                  {!enabled && " · paused"}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Revoke ${k.label}`}
                onClick={() => void revoke(k)}
                disabled={busy}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

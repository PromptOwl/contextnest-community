/**
 * ApiKeysPage — one place to see and manage the account's external-client
 * keys (MCP, CLI, curl).
 *
 * Several keys per account is the point: wire one per place you connect
 * from, and losing the plaintext for one no longer forces a rotate that
 * silently disconnects every other client. Plaintext is still shown exactly
 * once at mint time — you can't re-read a key, only replace it.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTitle } from "@/components/ui/page-title";
import * as api from "../../../lib/api";
import { reads, useApiKeys } from "../../../lib/queries";
import { parseServerDate } from "../../../lib/dates";
import { KeyRevealModal } from "../../../components/ConnectModal";

function when(value: string | null): string {
  if (!value) return "never";
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString() : "never";
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useApiKeys();
  const keys = data?.keys ?? [];

  const [label, setLabel] = useState("");
  // One id at a time: which row is mid-request, so only its button spins.
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{
    apiKey: string;
    kind: "generated" | "rotated";
  } | null>(null);

  // A name is what tells two keys apart once the plaintext is gone, so the
  // server requires one and refuses duplicates. Mirror both here rather than
  // letting the user submit into a rejection.
  const trimmedLabel = label.trim();
  const duplicateName = keys.some(
    (k) => k.label?.trim().toLowerCase() === trimmedLabel.toLowerCase(),
  );
  const canGenerate = trimmedLabel.length > 0 && !duplicateName;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: reads.apiKeys().queryKey });

  async function run(
    id: string,
    fn: () => Promise<{ api_key: string }>,
    kind: "generated" | "rotated",
  ) {
    setBusy(id);
    try {
      const { api_key } = await fn();
      setReveal({ apiKey: api_key, kind });
      if (id === "new") setLabel("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      // Refresh either way: on failure the server is still the truth about
      // what the account holds.
      refresh();
      setBusy(null);
    }
  }

  async function revoke(id: string, name: string) {
    if (
      !window.confirm(
        `Revoke "${name}"? Anything still using this key stops working immediately.`,
      )
    )
      return;
    setBusy(id);
    try {
      await api.deleteApiKey(id);
      toast.success("Key revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't revoke.");
    } finally {
      refresh();
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle
        icon={KeyRound}
        title="API keys"
        description="Each key authenticates every nest you can see, plus the server-level MCP endpoint. Make one per place you connect from — then rotating the key for one client leaves the others alone."
        className="mb-0"
      />
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canGenerate) return;
          run(
            "new",
            () => api.createApiKey({ label: trimmedLabel }),
            "generated",
          );
        }}
      >
        <div className="flex-1">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="What's this key for? e.g. Claude Desktop, laptop CLI"
            aria-label="Key name"
            aria-invalid={duplicateName || undefined}
          />
          {duplicateName && (
            <p className="mt-1 text-xs text-destructive">
              You already have a key with this name.
            </p>
          )}
        </div>
        <Button
          type="submit"
          disabled={busy === "new" || !canGenerate}
          className="shrink-0"
        >
          {busy === "new" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Generate key
        </Button>
      </form>

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Loading your keys…
        </p>
      ) : keys.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          No keys yet. Generate one above to connect an AI client.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {keys.map((k) => {
            const name = k.label || "Unnamed key";
            return (
              <li
                key={k.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{k.key_prefix}</code> ·
                    created {when(k.created_at)} · last used{" "}
                    {when(k.last_used_at)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === k.id}
                    onClick={() =>
                      run(
                        k.id,
                        () => api.rotateApiKey({ key_id: k.id }),
                        "rotated",
                      )
                    }
                  >
                    {busy === k.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Rotate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy === k.id}
                    onClick={() => revoke(k.id, name)}
                    aria-label={`Revoke ${name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        A key is shown once, when it's created. There's no way to read it
        back — if you lose one, rotate that key (its client needs the new
        value) or revoke it and make another.
      </p>

      {reveal && (
        <KeyRevealModal
          apiKey={reveal.apiKey}
          kind={reveal.kind}
          onClose={() => setReveal(null)}
        />
      )}
    </div>
  );
}

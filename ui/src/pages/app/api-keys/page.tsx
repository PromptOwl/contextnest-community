/**
 * ApiKeysPage — one place to see and manage the account's external-client
 * keys (MCP, CLI, curl).
 *
 * Several keys per account is the point: wire one per place you connect
 * from, and losing the plaintext for one no longer forces a rotate that
 * silently disconnects every other client. Plaintext is still shown exactly
 * once at mint time — you can't re-read a key, only replace it.
 *
 * Each key has a scope, shown as a badge on its row and picked when it's made:
 * all your nests (a user-level key), or one nest only — the key to hand an
 * agent that should see a single nest. See lib/api-key-scope.ts.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Boxes,
  Eye,
  KeyRound,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTitle } from "@/components/ui/page-title";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "../../../lib/api";
import { reads, useApiKeys, useNests } from "../../../lib/queries";
import {
  ALL_NESTS,
  createKeyRequest,
  filterSortKeys,
  keyCapability,
  keyScope,
  READ_ONLY_NEEDS_NEST,
  type KeyCapability,
  type KeyScopeFilter,
  type KeySort,
} from "../../../lib/api-key-scope";
import { parseServerDate } from "../../../lib/dates";
import { KeyRevealModal, RotateKeyConfirm } from "../../../components/ConnectModal";
import { ReasonDialog } from "../../../components/governance";

function when(value: string | null): string {
  if (!value) return "never";
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString() : "never";
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useApiKeys();
  const keys = data?.keys ?? [];
  // Every listed nest names a scope badge; the picker offers only the nests
  // you're a member of (not ones you merely discovered, or reach through a
  // single shared document) — the server refuses a key for a nest you can't
  // reach, and a public nest you happen to see is rarely what you mean.
  const { data: nestData } = useNests();
  const allNests: any[] = nestData?.nests ?? [];
  const nests: Array<{ id: string; name: string }> = allNests
    .filter((n) => !n.discovered && !n.grant_only)
    .map((n) => ({ id: n.id, name: n.name ?? n.id }));

  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<string>(ALL_NESTS);
  const [capability, setCapability] = useState<KeyCapability>("write");
  // A refused generate (e.g. the server's read-only 400) shows under the form.
  const [formError, setFormError] = useState<string | null>(null);
  // List controls — search, scope filter, sort.
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<KeyScopeFilter>("any");
  const [sort, setSort] = useState<KeySort>("newest");
  const shown = filterSortKeys(keys, allNests, { query, scope: scopeFilter, sort });
  // One id at a time: which row is mid-request, so only its button spins.
  const [busy, setBusy] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
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
  const readNeedsNest = capability === "read" && scope === ALL_NESTS;
  const canGenerate = trimmedLabel.length > 0 && !duplicateName && !readNeedsNest;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: reads.apiKeys().queryKey });

  async function run(
    id: string,
    fn: () => Promise<{ api_key: string }>,
    kind: "generated" | "rotated",
  ) {
    setBusy(id);
    if (id === "new") setFormError(null);
    try {
      const { api_key } = await fn();
      setReveal({ apiKey: api_key, kind });
      if (id === "new") {
        setLabel("");
        setScope(ALL_NESTS);
        setCapability("write");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong.";
      if (id === "new") setFormError(message);
      else toast.error(message);
    } finally {
      // Refresh either way: on failure the server is still the truth about
      // what the account holds.
      refresh();
      setBusy(null);
    }
  }

  async function revoke(id: string) {
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
        description="Make one key per place you connect from — then rotating the key for one client leaves the others alone."
        className="mb-0"
      />
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p className="rounded-md border p-2.5">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Layers className="h-3.5 w-3.5" /> All your nests
          </span>
          Works on every nest you can see, the server-level MCP endpoint, and
          your account (including managing keys). Use it for your own tools.
        </p>
        <p className="rounded-md border p-2.5">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Boxes className="h-3.5 w-3.5" /> One nest only
          </span>
          Reaches that one nest and nothing else — every other nest, your
          account, API keys and admin settings answer 403. Hand this one to an
          agent or integration. Make it read-only and it can't change anything
          either.
        </p>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canGenerate) return;
          run(
            "new",
            () => api.createApiKey(createKeyRequest(trimmedLabel, scope, capability)),
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
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger
            className="w-full sm:w-[200px] shrink-0"
            aria-label="What this key can reach"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_NESTS} disabled={capability === "read"}>
              All your nests
            </SelectItem>
            {nests.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                Only {n.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={capability}
          onValueChange={(v) => setCapability(v as KeyCapability)}
        >
          <SelectTrigger
            className="w-full sm:w-[140px] shrink-0"
            aria-label="What this key can do"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="write">Read-write</SelectItem>
            <SelectItem value="read">Read-only</SelectItem>
          </SelectContent>
        </Select>
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
      {(readNeedsNest || formError) && (
        <p className="text-xs text-destructive" role="alert">
          {readNeedsNest ? READ_ONLY_NEEDS_NEST : formError}
        </p>
      )}

      {keys.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, prefix or nest"
            aria-label="Search keys"
            className="flex-1"
          />
          <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v as KeyScopeFilter)}>
            <SelectTrigger className="w-full sm:w-[170px]" aria-label="Filter by scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any scope</SelectItem>
              <SelectItem value="all">All-nests keys</SelectItem>
              <SelectItem value="nest">One-nest keys</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as KeySort)}>
            <SelectTrigger className="w-full sm:w-[170px]" aria-label="Sort keys">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="last_used">Recently used</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Loading your keys…
        </p>
      ) : keys.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          No keys yet. Generate one above to connect an AI client.
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
          No keys match.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {shown.map((k) => {
            const name = k.label || "Unnamed key";
            const reach = keyScope(k, allNests);
            const can = keyCapability(k);
            return (
              <li
                key={k.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <Badge
                      variant="outline"
                      className={
                        reach.kind === "nest"
                          ? "shrink-0 gap-1 border-amber-200 bg-amber-50 text-amber-800"
                          : "shrink-0 gap-1"
                      }
                      title={
                        reach.kind === "nest"
                          ? "This key reaches this one nest only."
                          : "This key reaches every nest you can see."
                      }
                    >
                      {reach.kind === "nest" ? (
                        <Boxes className="h-3 w-3" />
                      ) : (
                        <Layers className="h-3 w-3" />
                      )}
                      <span className="max-w-[16rem] truncate">{reach.label}</span>
                    </Badge>
                    <Badge
                      variant="outline"
                      className="shrink-0 gap-1"
                      title={
                        can.kind === "read"
                          ? "This key can read but not change anything."
                          : "This key can read and write."
                      }
                    >
                      {can.kind === "read" ? (
                        <Eye className="h-3 w-3" />
                      ) : (
                        <Pencil className="h-3 w-3" />
                      )}
                      {can.label}
                    </Badge>
                  </div>
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
                    onClick={() => setRotateTarget({ id: k.id, name })}
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
                    onClick={() => setRevokeTarget({ id: k.id, name })}
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

      <RotateKeyConfirm
        target={rotateTarget}
        onConfirm={(id) =>
          run(id, () => api.rotateApiKey({ key_id: id }), "rotated")
        }
        onClose={() => setRotateTarget(null)}
      />
      {revokeTarget && (
        <ReasonDialog
          open
          onOpenChange={(open) => !open && setRevokeTarget(null)}
          title={`Revoke "${revokeTarget.name}"?`}
          description="Anything still using this key stops working immediately."
          confirmLabel="Revoke key"
          destructive
          onConfirm={() => revoke(revokeTarget.id)}
        />
      )}
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

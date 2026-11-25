/**
 * Setup: the email domains whose accounts this Slack connection may match
 * (the home nest's org_domains). Only a shared server uses them; with none,
 * nobody but the person who connected Slack can be matched.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { getNestSettings, updateNestSettings } from "../../../lib/api";

export const parseDomains = (s: string): string[] => [
  ...new Set(
    s
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  ),
];

export function EmailDomains({ nestId, nestName, onSaved }: { nestId: string; nestName?: string; onSaved?: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSaved(null);
    setError(null);
    getNestSettings(nestId)
      .then((r) => {
        if (!live) return;
        const v = (r.org_domains ?? []).join(", ");
        setSaved(v);
        setText(v);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the email domains."));
    return () => {
      live = false;
    };
  }, [nestId]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await updateNestSettings(nestId, { org_domains: parseDomains(text) });
      const v = (r.org_domains ?? parseDomains(text)).join(", ");
      setSaved(v);
      setText(v);
      toast.success("Email domains saved.");
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the email domains.");
    } finally {
      setBusy(false);
    }
  };
  const none = saved === "";
  return (
    <div className={cn("mb-4 rounded-lg border p-4 text-sm", none && "border-amber-200 bg-amber-50 text-amber-900")} data-testid="setup-email-domains" data-empty={none ? "true" : "false"}>
      <Label htmlFor="setup-email-domains-input" className="font-medium">
        Email domains
      </Label>
      <p className="mt-1">
        {none && <b>No domain is set, so nobody but the person who connects Slack can be matched. </b>}
        This server hosts several organizations, so a Slack member is matched to an account only when their email domain is listed here. Each person still needs the same verified email in both places, and matching gives no access.
        {nestName && <> Saved on {nestName}, where this connection&apos;s notes land; that nest&apos;s own organization settings use the same list.</>}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          id="setup-email-domains-input"
          className="h-9 max-w-md bg-background"
          value={text}
          placeholder="acme.com, acme.co.uk"
          disabled={busy || saved === null}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="outline" className="h-9" onClick={save} disabled={busy || saved === null || parseDomains(text).join(", ") === saved}>
          Save
        </Button>
      </div>
      {error && (
        <p className="mt-1 text-red-800" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

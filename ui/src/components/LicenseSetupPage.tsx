import { useState } from "react";
import { KeyRound, Loader2, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { installLicense } from "../lib/api";

interface Props {
  onActivated: () => void;
}

export function LicenseSetupPage({ onActivated }: Props) {
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the key validated but did NOT persist to disk — the operator must
  // see this before continuing, or they'll lose the key on the next restart.
  const [warning, setWarning] = useState<string | null>(null);

  const handleInstall = async () => {
    const trimmed = key.trim();
    if (!trimmed.startsWith("pk_")) {
      setError("License key must start with pk_");
      return;
    }
    setError(null);
    setWarning(null);
    setSubmitting(true);
    try {
      const res = await installLicense(trimmed);
      if (!res.valid) {
        setError(res.error || "PromptOwl rejected this key.");
        return;
      }
      if (res.warning) {
        // Validated but not durable. Don't silently proceed — surface it and
        // make the operator acknowledge with "Continue anyway".
        setWarning(res.warning);
        return;
      }
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install key");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Activate ContextNest Community</h1>
          <p className="text-sm text-muted-foreground">
            This server is in setup mode. Paste a PromptOwl license key to
            unlock write access.
          </p>
        </div>

        <div className="border rounded-lg p-6 space-y-4 bg-card">
          <div className="space-y-2">
            <Label htmlFor="license-key">License key</Label>
            <Input
              id="license-key"
              data-testid="license-setup-key-input"
              placeholder="pk_..."
              value={key}
              autoFocus
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) handleInstall();
              }}
              className="font-mono"
            />
            {error && (
              <p
                className="text-sm text-destructive"
                data-testid="license-setup-error"
              >
                {error}
              </p>
            )}
            {warning && (
              <div
                className="text-sm rounded-md border border-amber-300 bg-amber-50 text-amber-800 p-3 space-y-1"
                data-testid="license-setup-warning"
              >
                <p className="font-medium">License not saved to disk</p>
                <p>{warning}</p>
              </div>
            )}
          </div>

          {warning ? (
            <Button
              className="w-full"
              variant="outline"
              onClick={onActivated}
              data-testid="license-setup-continue"
            >
              Continue anyway (key lost on restart)
            </Button>
          ) : (
            <Button
              className="w-full"
              onClick={handleInstall}
              disabled={submitting || !key.trim()}
              data-testid="license-setup-submit"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Validating...
                </>
              ) : (
                <>
                  <KeyRound className="h-4 w-4 mr-2" />
                  Activate Server
                </>
              )}
            </Button>
          )}
        </div>

        <div className="text-sm text-muted-foreground space-y-2 border rounded-lg p-4 bg-muted/30">
          <p className="font-medium text-foreground">Need a key?</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>
              Sign up free at{" "}
              <a
                href="https://app.promptowl.ai"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline inline-flex items-center gap-1"
              >
                app.promptowl.ai
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>Open Overview &gt; Community License</li>
            <li>Generate a key and paste it above</li>
          </ol>
          <p className="text-xs pt-2">
            Reads stay available without a license. Writes (nest/node create,
            update, delete) require activation.
          </p>
        </div>
      </div>
    </div>
  );
}

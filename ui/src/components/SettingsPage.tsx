/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Each setting applies live and persists across restarts. Add new
 * settings as sibling <Card>s.
 */
import { useEffect, useState } from "react";
import { ArrowLeft, Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import type { AdminSettings, SignInGate } from "../lib/api";

interface SettingsPageProps {
  onBack: () => void;
  settings: AdminSettings | null;
  onUpdate: (patch: Partial<AdminSettings>) => void;
}

const GATE_OPTIONS: { value: SignInGate; label: string; hint: string }[] = [
  { value: "open", label: "Everyone", hint: "Anyone can sign in with PromptOwl." },
  { value: "admin-only", label: "Admins only", hint: "Only the server admin can use PromptOwl sign-in." },
  { value: "disabled", label: "Off", hint: "Hide PromptOwl sign-in — email & password only." },
];

/** A label + text input + Save row that only enables Save when changed. */
function TextSetting({
  value,
  placeholder,
  onSave,
  type = "text",
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  type?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <div className="flex items-center gap-2">
      <Input
        value={draft}
        type={type}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1"
      />
      <Button size="sm" disabled={!dirty} onClick={() => onSave(draft)}>
        Save
      </Button>
    </div>
  );
}

export function SettingsPage({ onBack, settings, onUpdate }: SettingsPageProps) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-2xl font-semibold">Server settings</h2>
          <p className="text-sm text-muted-foreground">
            Server-wide options. Changes apply immediately and persist across
            restarts.
          </p>
        </div>
      </div>

      {!settings ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      ) : (
        <div className="space-y-4 max-w-2xl">
          {/* PromptOwl sign-in gate */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="h-4 w-4 text-muted-foreground" />
                PromptOwl sign-in
              </CardTitle>
              <CardDescription>
                Who can sign in to this server using their PromptOwl account.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {GATE_OPTIONS.map((opt) => {
                  const active = settings.promptowl_sign_in_gate === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        !active && onUpdate({ promptowl_sign_in_gate: opt.value })
                      }
                      className={`text-left rounded-lg border p-3 transition-colors ${
                        active
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "hover:bg-muted/50"
                      }`}
                      aria-pressed={active}
                    >
                      <div className="text-sm font-medium">{opt.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {opt.hint}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Logo */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Logo</CardTitle>
              <CardDescription>
                URL of the logo shown in the header. Leave empty for the default.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TextSetting
                value={settings.logo_url ?? ""}
                placeholder="https://example.com/logo.svg"
                onSave={(v) => onUpdate({ logo_url: v })}
              />
            </CardContent>
          </Card>

          {/* Usage telemetry */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Usage telemetry</CardTitle>
              <CardDescription>
                Send anonymous usage counts to PromptOwl. Turn off to keep all
                usage data on this server.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-sm">
                  {settings.telemetry_enabled ? "On" : "Off"}
                </span>
                <Switch
                  checked={settings.telemetry_enabled}
                  onCheckedChange={(v) => onUpdate({ telemetry_enabled: v })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Public base URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Public base URL</CardTitle>
              <CardDescription>
                This server's public address — used for share links and SSO
                redirects. Leave empty if unsure.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TextSetting
                value={settings.public_base_url ?? ""}
                placeholder="https://nest.yourcompany.com"
                onSave={(v) => onUpdate({ public_base_url: v })}
              />
            </CardContent>
          </Card>

          {/* Slack connector */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Slack notifications</CardTitle>
              <CardDescription>
                Post governance events (review requested, approved, rejected,
                nest shared) to a Slack channel via an incoming-webhook URL.
                Leave empty to turn the connector off. The URL contains a
                secret — treat it like a password.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TextSetting
                type="password"
                value={settings.slack_webhook_url ?? ""}
                placeholder="https://hooks.slack.com/services/…"
                onSave={(v) => onUpdate({ slack_webhook_url: v })}
              />
            </CardContent>
          </Card>

          {/* Max upload size */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Max upload size</CardTitle>
              <CardDescription>
                Largest request/file accepted, in megabytes. Raise this if big
                HTML artifacts (decks, dashboards) get rejected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <TextSetting
                  type="number"
                  value={String(Math.round(settings.max_body_bytes / (1024 * 1024)))}
                  onSave={(v) => {
                    const mb = Number(v);
                    if (Number.isFinite(mb) && mb > 0)
                      onUpdate({ max_body_bytes: Math.floor(mb * 1024 * 1024) });
                  }}
                />
                <span className="text-sm text-muted-foreground shrink-0">MB</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

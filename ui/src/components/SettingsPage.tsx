/**
 * SettingsPage — server-level admin settings. A home for toggles that aren't
 * per-nest. Today: the PromptOwl sign-in gate. Add new settings as sibling
 * cards below.
 */
import { ArrowLeft, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import type { SignInGate } from "../lib/api";

interface SettingsPageProps {
  onBack: () => void;
  signInGate: SignInGate;
  onSetSignInGate: (value: SignInGate) => void;
}

const GATE_OPTIONS: { value: SignInGate; label: string; hint: string }[] = [
  { value: "open", label: "Everyone", hint: "Anyone can sign in with PromptOwl." },
  { value: "admin-only", label: "Admins only", hint: "Only the server admin can use PromptOwl sign-in." },
  { value: "disabled", label: "Off", hint: "Hide PromptOwl sign-in entirely — email & password only." },
];

export function SettingsPage({ onBack, signInGate, onSetSignInGate }: SettingsPageProps) {
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

      <div className="space-y-4 max-w-2xl">
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
                const active = signInGate === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => !active && onSetSignInGate(opt.value)}
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

        {/* Add more server-setting cards here. */}
      </div>
    </div>
  );
}

/**
 * Settings → Features → Plugins. The superadmin's switch for Nest Plugins
 * (FEATURE_PLUGINS), the allowlist of plugin packages (PLUGINS), and what the
 * server actually loaded from it. Edits go into the page's draft and save
 * with the page's one Save, like every other card here; saving reloads the
 * plugin set live, no restart.
 */
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BetaBadge } from "@/components/ui/beta-badge";
import type { PluginLoaded, PluginLoadError } from "../../../lib/api";

export interface PluginsSettingsCardProps {
  enabled: boolean;
  packages: string;
  /** From GET /admin/settings — reflects the SAVED allowlist. */
  loaded: PluginLoaded[];
  loadErrors: PluginLoadError[];
  /** The allowlist or the switch was edited but not saved yet. */
  dirty?: boolean;
  /** The server's reason the last save refused plugins_packages. */
  error?: string;
  onChange: (patch: { plugins_enabled?: boolean; plugins_packages?: string }) => void;
}

export function PluginsSettingsCard({ enabled, packages, loaded, loadErrors, dirty, error, onChange }: PluginsSettingsCardProps) {
  return (
    <Card data-testid="settings-plugins">
      <CardHeader>
        <CardTitle className="text-base">
          Plugins <BetaBadge className="ml-1 align-middle" />
        </CardTitle>
        <CardDescription>
          Bring content from outside sources, such as the markdown in a GitHub repository, into nests. Each nest's owners
          choose which plugins to turn on from the nest's Plugins page. What a plugin writes goes through the nest's
          review and structure rules. Off by default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm">{enabled ? "On" : "Off"}</span>
          <Switch checked={enabled} onCheckedChange={(v) => onChange({ plugins_enabled: v })} aria-label="Nest Plugins" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plugins_packages">Plugin packages</Label>
          <Input
            id="plugins_packages"
            value={packages}
            placeholder="@promptowl/contextnest-plugin-github-markdown"
            onChange={(e) => onChange({ plugins_packages: e.target.value })}
            disabled={!enabled}
            aria-invalid={!!error}
            className={`font-mono text-xs ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
            autoComplete="off"
            spellCheck={false}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">
            Comma-separated npm package names installed on this server, or absolute paths to a module. Only what is named
            here loads, because plugins run inside the server.
          </p>
        </div>
        {enabled && (
          <div className="space-y-1.5 border-t pt-3">
            <div className="text-sm font-medium">Loaded</div>
            {dirty && <p className="text-xs text-muted-foreground">Save to load this list. What follows is the saved one.</p>}
            {loaded.length === 0 && loadErrors.length === 0 ? (
              <p className="text-xs text-muted-foreground">No plugins loaded.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {loaded.map((p) => (
                  <li key={p.name} className="flex flex-wrap items-center gap-x-2">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-700 dark:text-green-400" aria-hidden />
                    <span>{p.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.name} v{p.version} · {p.capabilities.join(", ")}
                    </span>
                  </li>
                ))}
                {loadErrors.map((e) => (
                  <li key={e.spec} className="flex items-start gap-x-2 text-xs text-destructive">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="break-words">
                      <span className="font-mono">{e.spec}</span>: {e.error}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

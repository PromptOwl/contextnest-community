/**
 * BrandingSettingsModal — super-admin white-label controls.
 *
 * Edits the server-wide branding (logo, product name, sign-in tagline) that
 * `/health` serves to every client. Visible only when `isSuperAdmin`; the
 * server re-checks on PUT /admin/branding and 403s otherwise. On save we
 * re-pull /health via refreshBranding so the header/login update in place.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Palette, AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import * as api from "../lib/api";
import hootieIcon from "../assets/hootie.svg";

interface BrandingSettingsModalProps {
  onClose: () => void;
}

export function BrandingSettingsModal({ onClose }: BrandingSettingsModalProps) {
  const { logoUrl, appName, signInTagline, refreshBranding } = useAuth();
  const [name, setName] = useState(appName);
  const [logo, setLogo] = useState(logoUrl ?? "");
  const [tagline, setTagline] = useState(signInTagline ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateBranding({
        app_name: name,
        logo_url: logo,
        sign_in_tagline: tagline,
      });
      await refreshBranding();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save branding");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            Branding
          </DialogTitle>
          <DialogDescription>
            Server-wide white-label. Applies to the header, login screen, and
            browser tab for everyone. Leave a field blank to fall back to the
            default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Live preview of how the header lockup will read. */}
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <img
              src={logo.trim() || hootieIcon}
              alt=""
              className="h-6 w-6 rounded"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src = hootieIcon;
              }}
            />
            <span className="font-semibold">{name.trim() || "ContextNest"}</span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brand-name">Product name</Label>
            <Input
              id="brand-name"
              value={name}
              maxLength={60}
              placeholder="ContextNest"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brand-logo">Logo URL</Label>
            <Input
              id="brand-logo"
              value={logo}
              placeholder="https://… or data:image/…"
              onChange={(e) => setLogo(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Must start with https://, http://, or data:image/. Blank uses the
              bundled icon.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brand-tagline">Sign-in tagline</Label>
            <Input
              id="brand-tagline"
              value={tagline}
              maxLength={140}
              placeholder="Shown under the logo on the login screen"
              onChange={(e) => setTagline(e.target.value)}
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save branding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

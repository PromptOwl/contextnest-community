/**
 * AdminLoginModal — login flow for both open mode (claim admin) and key mode.
 * Supports PromptOwl device auth + email/password fallback.
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield, AlertCircle, Loader2, ExternalLink, Copy, Check, KeyRound } from "lucide-react";
import * as api from "../lib/api";
import type { ClaimBlocked } from "../lib/api";
import { useAuth } from "../auth/AuthContext";

interface AdminLoginModalProps {
  alreadyClaimed: boolean;
  existingAdmin: string | null;
  onClose: () => void;
}

export function AdminLoginModal({
  alreadyClaimed,
  existingAdmin,
  onClose,
}: AdminLoginModalProps) {
  const { loginSuccess } = useAuth();
  const [mode, setMode] = useState<"promptowl" | "password">("promptowl");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [claimBlocked, setClaimBlocked] = useState<{
    info: ClaimBlocked;
    attemptedEmail: string;
  } | null>(null);

  const copyCode = async () => {
    if (!deviceCode) return;
    await navigator.clipboard.writeText(deviceCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handlePromptOwl = async () => {
    setError(null);
    setLoading(true);
    try {
      const device = await api.startDeviceAuth();
      setDeviceUrl(device.verificationUrl);
      setDeviceCode(device.deviceCode);
      window.open(device.verificationUrl, "_blank", "noopener,noreferrer");

      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await api.pollDeviceAuth(device.deviceCode, device.clientSecret);
        if (poll.status === "approved" && poll.token) {
          const exchange = await api.exchangePromptOwlToken(poll.token);
          loginSuccess(
            exchange.user
              ? {
                email: exchange.user.email,
                name: exchange.user.name,
                is_admin: !!exchange.user.is_admin,
              }
              : undefined,
          );
          // Claim attempt blocked — keep modal open so user can resolve.
          if (exchange.claim_blocked && !exchange.user.is_admin) {
            setClaimBlocked({
              info: exchange.claim_blocked,
              attemptedEmail: exchange.user.email,
            });
            setDeviceUrl(null);
            setDeviceCode(null);
            setLoading(false);
            return;
          }
          onClose();
          return;
        }
        if (poll.status === "expired") {
          setError("Login expired. Try again.");
          setDeviceUrl(null);
          setDeviceCode(null);
          setLoading(false);
          return;
        }
      }
    } catch (err: any) {
      setError(err.message);
      setDeviceUrl(null);
      setDeviceCode(null);
      setLoading(false);
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login(email, password);
      loginSuccess(
        res.user
          ? {
            email: res.user.email,
            name: res.user.name,
            is_admin: !!res.user.is_admin,
          }
          : undefined,
      );
      onClose();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {alreadyClaimed ? "Login" : "Claim as Admin"}
          </DialogTitle>
          <DialogDescription>
            {alreadyClaimed
              ? existingAdmin
                ? `This server is administered by ${existingAdmin}. Login to manage settings and teammates.`
                : "Login with your account."
              : "The first PromptOwl-authenticated user becomes this server's admin. Admins can enable stewardship, invite teammates, and manage settings."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {claimBlocked && (
            <Alert variant="destructive">
              <KeyRound className="h-4 w-4" />
              <AlertDescription>
                {claimBlocked.info.reason === "license_required" ? (
                  <div className="space-y-2">
                    <p className="font-medium">
                      Admin claim blocked — no license installed.
                    </p>
                    <p className="text-xs">
                      Generate a Community License key in PromptOwl, then
                      paste it on the setup screen. Only the PromptOwl
                      account that minted the key can claim admin on this
                      server.
                    </p>
                    <a
                      href="https://app.promptowl.ai/community-license"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline"
                    >
                      Open Community License page
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="font-medium">
                      Admin claim blocked — email does not match license owner.
                    </p>
                    <p className="text-xs">
                      License owner:{" "}
                      <code className="font-mono">
                        {claimBlocked.info.license_owner_email || "(unknown)"}
                      </code>
                    </p>
                    <p className="text-xs">
                      You logged in as:{" "}
                      <code className="font-mono">
                        {claimBlocked.attemptedEmail}
                      </code>
                    </p>
                    <p className="text-xs">
                      Log in with the PromptOwl account that generated the
                      installed license key, or install a different key
                      belonging to this account.
                    </p>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {mode === "promptowl" ? (
            <>
              <Button
                onClick={handlePromptOwl}
                disabled={loading}
                className="w-full"
              >
                {loading && deviceUrl ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Waiting for approval...
                  </>
                ) : (
                  "Login with PromptOwl"
                )}
              </Button>

              {deviceUrl && (
                <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    A new tab opened at{" "}
                    <a
                      href={deviceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline"
                    >
                      PromptOwl
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    . If it asks for a verification code, use this:
                  </p>
                  {deviceCode && (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-background border rounded px-2 py-1.5 text-xs font-mono break-all">
                        {deviceCode}
                      </code>
                      <Button size="sm" variant="outline" onClick={copyCode}>
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    or
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => setMode("password")}
              >
                Use email + password
              </Button>
            </>
          ) : (
            <form onSubmit={handlePassword} className="space-y-3">
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label>Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Login"
                )}
              </Button>
              <button
                type="button"
                onClick={() => setMode("promptowl")}
                className="w-full text-xs text-muted-foreground hover:text-foreground"
              >
                ← Back to PromptOwl login
              </button>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

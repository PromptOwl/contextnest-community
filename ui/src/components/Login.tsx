import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import * as api from "../lib/api";
import { useAuth } from "../auth/AuthContext";

export function Login() {
  const { loginSuccess, logoUrl } = useAuth();
  const [mode, setMode] = useState<"login" | "register" | "promptowl">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deviceUrl, setDeviceUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const copyCode = async () => {
    if (!deviceCode) return;
    await navigator.clipboard.writeText(deviceCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res =
        mode === "register"
          ? await api.register(email, password, name)
          : await api.login(email, password);
      loginSuccess(
        res.user
          ? {
              email: res.user.email,
              name: res.user.name,
              is_admin: !!res.user.is_admin,
            }
          : undefined,
      );
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePromptOwl = async () => {
    setError(null);
    setLoading(true);
    try {
      const device = await api.startDeviceAuth();
      setDeviceUrl(device.verificationUrl);
      setDeviceCode(device.deviceCode);
      window.open(device.verificationUrl, "_blank", "noopener,noreferrer");

      // Poll for approval. Only "pending" keeps the loop alive — any
      // other status (denied/rejected/expired/cancelled/unknown) is
      // terminal so the user isn't stuck on "Waiting for approval...".
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
          return;
        }
        if (poll.status === "pending") continue;

        const terminalMsg =
          poll.status === "denied" || poll.status === "rejected"
            ? "Login denied. Approve the request in PromptOwl to continue, or try again."
            : poll.status === "expired"
              ? "Login expired. Try again."
              : poll.status === "cancelled"
                ? "Login cancelled. Try again."
                : `Login failed (status: ${poll.status}). Try again.`;
        setError(terminalMsg);
        setDeviceUrl(null);
        setDeviceCode(null);
        setLoading(false);
        return;
      }
      // Loop exhausted — 180 * 2s = 6 min w/o approval.
      setError("Login timed out waiting for approval. Try again.");
      setDeviceUrl(null);
      setDeviceCode(null);
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setDeviceUrl(null);
      setDeviceCode(null);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 p-6">
        <div className="text-center">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="h-12 w-12 mx-auto object-contain"
            />
          ) : (
            <span className="text-4xl">🪺</span>
          )}
          <h1 className="text-xl font-semibold mt-2">ContextNest</h1>
          <p className="text-sm text-muted-foreground">Community Server</p>
        </div>

        {/* PromptOwl Login */}
        <button
          onClick={handlePromptOwl}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg border border-border bg-card hover:bg-secondary text-sm font-medium transition-colors"
        >
          {loading && deviceUrl ? "Waiting for approval..." : "Login with PromptOwl"}
        </button>

        {deviceUrl && (
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              A new tab opened at{" "}
              <a
                href={deviceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                PromptOwl
              </a>
              . If it asks for a verification code, use this:
            </p>
            {deviceCode && (
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-background border rounded px-2 py-1.5 text-xs font-mono break-all">
                  {deviceCode}
                </code>
                <button
                  type="button"
                  onClick={copyCode}
                  className="px-2 py-1.5 rounded border text-xs hover:bg-secondary"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Hide email/password path while PromptOwl device-auth flow is
            live — keeps focus on the active flow and avoids accidental
            credential entry mid-poll. */}
        {!deviceUrl && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>

            {/* Email/Password */}
            <form onSubmit={handleSubmit} className="space-y-3">
              {mode === "register" && (
                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                />
              )}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              />
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 pr-9 rounded-md border border-input bg-background text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                  className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {loading ? "..." : mode === "register" ? "Create Account" : "Login"}
              </button>
            </form>
          </>
        )}

        {error && (
          <p className="text-sm text-destructive text-center">{error}</p>
        )}

        {!deviceUrl && (
          <p className="text-xs text-center text-muted-foreground">
            {mode === "login" ? (
              <>
                No account?{" "}
                <button onClick={() => setMode("register")} className="text-primary underline">
                  Register
                </button>
              </>
            ) : (
              <>
                Have an account?{" "}
                <button onClick={() => setMode("login")} className="text-primary underline">
                  Login
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

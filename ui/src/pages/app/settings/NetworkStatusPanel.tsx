/**
 * Settings → Network & status. For whoever operates this server: is it
 * healthy, can people and agents reach it, can it reach what it depends on,
 * and how to deploy it behind a firewall, VPN, proxy or tunnel.
 *
 * Everything here is read-only. The data comes from /admin/status (admin-only,
 * secret-free — see src/ops/status.ts); the "Run" buttons call the probe
 * routes, which only ever dial hosts derived from this server's own config.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Copy,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { copyTextWithToast } from "../../../lib/clipboard";
import {
  getServerStatus,
  runEgressCheck,
  runInboundCheck,
  runOidcDiscoveryCheck,
  type CheckState,
  type DiscoveryReport,
  type EgressReport,
  type InboundReport,
  type ProbeStage,
  type StatusCheck,
  type StatusReport,
} from "../../../lib/api";

const GROUPS: { id: StatusCheck["group"]; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "license", label: "License" },
  { id: "network", label: "Network" },
  { id: "services", label: "Services" },
  { id: "runtime", label: "Runtime" },
];

function StateIcon({ state, className = "h-4 w-4" }: { state: CheckState | "ok" | "fail"; className?: string }) {
  if (state === "green" || state === "ok") return <CircleCheck className={`${className} text-green-600 dark:text-green-400`} aria-label="OK" />;
  if (state === "amber") return <TriangleAlert className={`${className} text-amber-600 dark:text-amber-400`} aria-label="Warning" />;
  if (state === "red" || state === "fail") return <CircleX className={`${className} text-red-600 dark:text-red-400`} aria-label="Problem" />;
  return <CircleMinus className={`${className} text-muted-foreground`} aria-label="Not in use" />;
}

/** Copy button that flips to "Copied" briefly. */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      onClick={async () => {
        if (!(await copyTextWithToast(text))) return;
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="ml-1.5">{done ? "Copied" : label}</span>
    </Button>
  );
}

/** A labelled, copyable value — for things an admin pastes into another console. */
function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={value}>
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
        <span className="text-xs font-medium">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

/** Expandable section; closed by default so the guide reads as a menu. */
function Expandable({ title, summary, children, defaultOpen = false }: { title: string; summary: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{summary}</span>
        </span>
      </button>
      {open && <div className="space-y-3 border-t px-3 py-3 text-sm">{children}</div>}
    </div>
  );
}

function Stages({ stages }: { stages: ProbeStage[] }) {
  return (
    <ol className="flex flex-wrap gap-x-3 gap-y-1">
      {stages.map((s) => (
        <li key={s.stage} className="flex items-center gap-1 text-xs" title={s.detail}>
          <StateIcon state={s.ok ? "ok" : "fail"} className="h-3.5 w-3.5" />
          <span className="font-medium uppercase">{s.stage}</span>
          <span className="text-muted-foreground">{s.ok ? `${s.ms} ms` : s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function Hint({ tone, children }: { tone: "amber" | "red" | "muted"; children: ReactNode }) {
  const cls =
    tone === "red"
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : tone === "amber"
        ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border bg-muted/40 text-muted-foreground";
  return <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>{children}</div>;
}

function useProbe<T>(run: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await run());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [run]);
  return { busy, result, error, go };
}

function RunButton({ busy, onClick, children }: { busy: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClick}>
      {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
      {children}
    </Button>
  );
}

// ─── Status ─────────────────────────────────────────────────────────────

function StatusCard({ report, loading, error, onRefresh }: { report: StatusReport | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const counts = useMemo(() => {
    const c = { red: 0, amber: 0 };
    for (const k of report?.checks ?? []) if (k.state === "red" || k.state === "amber") c[k.state]++;
    return c;
  }, [report]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Server status</CardTitle>
          <CardDescription>
            Health of the database, storage, license and connected services. Anything not green says what to do about it.
          </CardDescription>
        </div>
        <RunButton busy={loading} onClick={onRefresh}>
          Refresh
        </RunButton>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Hint tone="red">Couldn't load status: {error}</Hint>}
        {report && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {counts.red > 0 && <Badge variant="rejected">{counts.red} need attention</Badge>}
              {counts.amber > 0 && <Badge variant="warning">{counts.amber} warnings</Badge>}
              {counts.red === 0 && counts.amber === 0 && <Badge variant="success">All checks passing</Badge>}
              <span>Checked {new Date(report.generatedAt).toLocaleTimeString()}</span>
            </div>
            {GROUPS.map((g) => {
              const rows = report.checks.filter((c) => c.group === g.id);
              if (!rows.length) return null;
              return (
                <section key={g.id}>
                  <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.label}</h4>
                  <ul className="divide-y rounded-md border">
                    {rows.map((c) => (
                      <li key={c.id} className="flex gap-3 px-3 py-2.5">
                        <StateIcon state={c.state} className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-sm font-medium">{c.label}</span>
                            <span className="break-words text-xs text-muted-foreground">{c.detail}</span>
                          </div>
                          {c.fix && <p className="text-xs">{c.fix}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
        {!report && loading && <p className="text-sm text-muted-foreground">Checking…</p>}
      </CardContent>
    </Card>
  );
}

// ─── Reachability ───────────────────────────────────────────────────────

function ReachabilityCard({ report }: { report: StatusReport }) {
  const inbound = useProbe<InboundReport>(runInboundCheck);
  const egress = useProbe<EgressReport>(runEgressCheck);
  const a = report.address;
  const allowlist = report.egress.map((t) => `${t.host}:${t.port}  # ${t.purpose}${t.required ? "" : " (optional)"}`).join("\n");
  const byId = new Map(egress.result?.results.map((r) => [r.id, r]) ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reachability</CardTitle>
        <CardDescription>
          Two directions to get right behind a firewall: people and agents reaching this server, and this server reaching the services it depends on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="text-sm font-medium">Inbound — can people and agents reach this server?</h4>
              <p className="text-xs text-muted-foreground">
                Browsers, Claude Code and the CLI connect from people's own machines, so a VPN works for them. Hosted connectors
                (claude.ai, ChatGPT) connect from the vendor's servers and need a public name with a trusted certificate.
              </p>
            </div>
            <RunButton busy={inbound.busy} onClick={inbound.go}>
              Check public address
            </RunButton>
          </div>
          <div className="space-y-1.5 rounded-md border bg-muted/20 p-3">
            <CopyValue label={a.pinned ? "Public base URL" : "Address (not pinned)"} value={a.effectiveBaseUrl || "—"} />
            <div className="flex gap-2 text-xs">
              <span className="w-40 shrink-0 text-muted-foreground">This page arrived via</span>
              <span className="min-w-0 break-all">{a.requestOrigin || "—"}</span>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="w-40 shrink-0 text-muted-foreground">Proxy headers seen</span>
              <span className="min-w-0">
                {a.forwarded.proto || a.forwarded.host || a.forwarded.for
                  ? [a.forwarded.proto && `X-Forwarded-Proto: ${a.forwarded.proto}`, a.forwarded.host && `X-Forwarded-Host: ${a.forwarded.host}`, a.forwarded.for && "X-Forwarded-For"]
                      .filter(Boolean)
                      .join(" · ")
                  : "None — this request didn't come through a reverse proxy"}
              </span>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="w-40 shrink-0 text-muted-foreground">App listens on port</span>
              <span>{report.listenPort}</span>
            </div>
          </div>
          {inbound.error && <Hint tone="red">{inbound.error}</Hint>}
          {inbound.result && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm">
                <StateIcon state={inbound.result.ok ? (inbound.result.privateAddresses ? "amber" : "green") : "red"} />
                <span className="font-medium">
                  {inbound.result.ok ? (inbound.result.privateAddresses ? "Reachable on your network only" : "Public address works") : "Public address check failed"}
                </span>
              </div>
              {inbound.result.stages.length > 0 && <Stages stages={inbound.result.stages} />}
              {inbound.result.hint && <p className="text-xs">{inbound.result.hint}</p>}
              <p className="text-xs text-muted-foreground">{inbound.result.note}</p>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="text-sm font-medium">Outbound — can this server reach what it needs?</h4>
              <p className="text-xs text-muted-foreground">
                Every host this server's current settings make it call. Give this list to whoever runs your firewall or proxy.
              </p>
            </div>
            <RunButton busy={egress.busy} onClick={egress.go}>
              Test connections
            </RunButton>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Destination</th>
                  <th className="px-3 py-2 font-medium">Used for</th>
                  <th className="px-3 py-2 font-medium">Set by</th>
                  {egress.result && <th className="px-3 py-2 font-medium">Result</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.egress.map((t) => {
                  const r = byId.get(t.id);
                  return (
                    <tr key={`${t.id}-${t.host}`} className="align-top">
                      <td className="px-3 py-2">
                        <code>
                          {t.host}:{t.port}
                        </code>
                        {!t.required && <span className="ml-1.5 text-muted-foreground">optional</span>}
                      </td>
                      <td className="px-3 py-2">{t.purpose}</td>
                      <td className="px-3 py-2 text-muted-foreground">{t.configuredBy}</td>
                      {egress.result && (
                        <td className="px-3 py-2">
                          {r ? (
                            <div className="space-y-1">
                              <Stages stages={r.stages} />
                              {r.hint && <p className="max-w-sm">{r.hint}</p>}
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={allowlist} label="Copy allowlist" />
            {egress.result?.proxy && <span className="text-xs text-muted-foreground">HTTPS tested through {egress.result.proxy}</span>}
            {egress.result && egress.result.clockSkewSeconds !== null && (
              <span className={`text-xs ${Math.abs(egress.result.clockSkewSeconds) > 120 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                Clock is {Math.abs(egress.result.clockSkewSeconds)}s {egress.result.clockSkewSeconds >= 0 ? "ahead of" : "behind"} PromptOwl
                {Math.abs(egress.result.clockSkewSeconds) > 120 && " — sign-in tokens fail when clocks drift; enable NTP on the host."}
              </span>
            )}
          </div>
          {egress.error && <Hint tone="red">{egress.error}</Hint>}
        </section>
      </CardContent>
    </Card>
  );
}

// ─── Deployment guide ───────────────────────────────────────────────────

function DeploymentGuide({ report }: { report: StatusReport }) {
  const port = report.listenPort;
  const host = (() => {
    try {
      return new URL(report.address.effectiveBaseUrl).hostname;
    } catch {
      return "nest.example.com";
    }
  })();
  const publicHost = report.address.pinned && !report.address.privateHost ? host : "nest.example.com";

  const nginx = `server {
    listen 443 ssl;
    server_name ${publicHost};
    ssl_certificate     /etc/letsencrypt/live/${publicHost}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${publicHost}/privkey.pem;
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        # Overwrite, don't append: the server rate-limits by this address.
        proxy_set_header X-Forwarded-For   $remote_addr;
        # MCP streams responses — don't buffer them.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}`;
  const caddy = `${publicHost} {
    # Caddy gets the certificate and sets X-Forwarded-Proto itself, and
    # replaces any client-sent X-Forwarded-For with the real address.
    reverse_proxy 127.0.0.1:${port} {
        flush_interval -1
    }
}`;
  const cloudflared = `tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  # Only what hosted connectors need. Everything else stays private.
  - hostname: ${publicHost}
    path: ^/(mcp|\\.well-known/|oauth/|health$)
    service: http://localhost:${port}
  - service: http_status:404`;
  const proxyEnv = `HTTPS_PROXY=http://proxy.corp.example:3128
NO_PROXY=localhost,127.0.0.1,.corp.example
# Node's fetch only uses the proxy with this on (Node 22.21+):
NODE_USE_ENV_PROXY=1
# If the proxy inspects TLS, trust its CA (PEM file mounted into the container):
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-proxy-ca.pem`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deployment guide</CardTitle>
        <CardDescription>
          Pick the setup that matches your network. Values below use this server's address and port where known.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Expandable title="Public, with HTTPS" summary="Simplest. Everyone, including hosted connectors, can reach it.">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Point a DNS name (e.g. {publicHost}) at the server's public IP.</li>
            <li>Terminate TLS in front of the app with a reverse proxy (next section) or your cloud's load balancer. Use a publicly trusted certificate — hosted connectors reject self-signed ones.</li>
            <li>Open only port 443 inbound. Don't expose the app's own port ({port}) to the internet.</li>
            <li>Set the public base URL in Settings → Basic to <code>https://{publicHost}</code>.</li>
            <li>Click <strong>Check public address</strong> above.</li>
          </ol>
        </Expandable>

        <Expandable title="Behind a reverse proxy (nginx, Caddy, load balancer)" summary="The proxy handles HTTPS and forwards to the app on a private port.">
          <p>
            The app trusts the proxy's <code>X-Forwarded-Proto</code> to know a request was HTTPS (it decides whether cookies are marked Secure), and its
            <code>X-Forwarded-For</code> for the client IP that rate limits are keyed on. Make the proxy <strong>overwrite</strong> X-Forwarded-For rather than append, and
            keep the app's port reachable only from the proxy. Set <code>HOST=127.0.0.1</code> when the proxy runs on the same machine, and{" "}
            <code>TRUSTED_PROXIES</code> to the proxy's address so forwarded headers from anyone else are ignored.
          </p>
          <Snippet title="nginx" code={nginx} />
          <Snippet title="Caddyfile" code={caddy} />
        </Expandable>

        <Expandable title="VPN-only (private network)" summary="Works for your people; hosted connectors can't reach it.">
          <p>On a VPN or private network:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Works:</strong> the web app, Claude Code, Claude Desktop with a local config, the <code>ctx</code> CLI — they run on people's own
              machines and go through the VPN.
            </li>
            <li>
              <strong>Doesn't work:</strong> claude.ai and ChatGPT connectors, and Claude Desktop/Cowork <em>connectors</em>. They connect from the
              vendor's servers, which aren't on your VPN.
            </li>
          </ul>
          <p>To support hosted connectors anyway, pick one:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Publish only the connector paths — <code>/mcp</code>, <code>/.well-known/*</code>, <code>/oauth/*</code> — on a public name, and allow
              inbound only from{" "}
              <a className="underline" href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noopener noreferrer">
                Anthropic's published IP ranges
              </a>
              .
            </li>
            <li>Use a tunnel scoped to those paths (below), so nothing else is exposed.</li>
            <li>Skip hosted connectors and use Claude Code or the Desktop config, which work over the VPN.</li>
          </ol>
        </Expandable>

        <Expandable title="Home or office router (NAT, port forwarding)" summary="Forward 443 to the machine running the server.">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Give the server machine a fixed LAN address (a DHCP reservation).</li>
            <li>
              On the router, forward TCP <strong>443</strong> (and 80 if your proxy fetches certificates over HTTP) to that machine, where a reverse proxy
              terminates HTTPS. Never forward straight to the app's port {port} — it has no TLS of its own.
            </li>
            <li>Use a DNS name with dynamic DNS if your public IP changes.</li>
            <li>
              If <strong>Check public address</strong> fails from inside but works from a phone on mobile data, your router doesn't support hairpin NAT.
              The setup is fine; use split DNS internally.
            </li>
          </ol>
        </Expandable>

        <Expandable title="Tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel)" summary="No inbound ports opened; the tunnel connects out.">
          <p>
            A tunnel agent on the server connects out to the provider, which serves your public name with a trusted certificate. Expose only what you need
            — for hosted connectors that's <code>/mcp</code>, <code>/.well-known/*</code>, <code>/oauth/*</code> and <code>/health</code>. Then set the public
            base URL to the tunnel's address.
          </p>
          <Snippet title="cloudflared config.yml" code={cloudflared} />
          <Snippet title="ngrok" code={`ngrok http ${port} --url=${publicHost}`} />
          <Snippet title="Tailscale Funnel" code={`tailscale funnel --bg ${port}`} />
          <p className="text-xs text-muted-foreground">ngrok and Tailscale Funnel expose the whole app; put path rules in front if only the connector paths should be public.</p>
        </Expandable>

        <Expandable title="Corporate egress proxy" summary="Outbound traffic must go through a proxy, possibly with TLS inspection.">
          <p>
            Set the proxy in the server's environment (not in Settings — Node reads these once at startup). HTTPS calls (licensing, sign-in, AI models, SSO,
            webhooks) go through it. Email over SMTP and Postgres connect directly, so they need their own firewall rules. Use{" "}
            <strong>Copy allowlist</strong> above for the proxy's allowlist, then <strong>Test connections</strong>.
          </p>
          <Snippet title="Environment" code={proxyEnv} />
        </Expandable>
      </CardContent>
    </Card>
  );
}

// ─── Entra ──────────────────────────────────────────────────────────────

function EntraCard({ report }: { report: StatusReport }) {
  const discovery = useProbe<DiscoveryReport>(runOidcDiscoveryCheck);
  const base = report.address.effectiveBaseUrl.replace(/\/$/, "");
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Microsoft Entra ID sign-in</CardTitle>
          <CardDescription>The values to paste into Entra, in order. Then finish on the Single sign-on tab.</CardDescription>
        </div>
        <RunButton busy={discovery.busy} onClick={discovery.go}>
          Test discovery
        </RunButton>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!report.address.pinned && (
          <Hint tone="amber">The public base URL isn't set, so these values use the address this page was opened on. Set it on the Basic tab first if that's not the address people use.</Hint>
        )}
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            In the Entra admin center: <em>Identity → Applications → App registrations → New registration</em>.
            <div className="mt-1.5 space-y-1.5">
              <CopyValue label="Name" value="ContextNest" />
              <CopyValue label="Account type" value="Accounts in this organizational directory only (Single tenant)" />
            </div>
          </li>
          <li>
            <em>Authentication → Add a platform → Web</em>, and add the redirect URI:
            <div className="mt-1.5 space-y-1.5">
              <CopyValue label="Platform" value="Web" />
              <CopyValue label="Redirect URI" value={`${base}/auth/oidc/callback`} />
            </div>
          </li>
          <li>
            <em>Certificates &amp; secrets → New client secret</em>. Copy the secret <strong>Value</strong> (not the Secret ID) — it's shown once. Note the
            expiry: sign-in stops working after it.
          </li>
          <li>
            On the app's <em>Overview</em>, copy the <strong>Application (client) ID</strong> and the <strong>Directory (tenant) ID</strong>.
          </li>
          <li>
            On the <strong>Single sign-on</strong> tab: choose <strong>Microsoft Entra ID</strong>, paste the tenant ID (the GUID — not <code>common</code>{" "}
            or a domain), the client ID and the secret value, switch it on and save.
          </li>
          <li>
            Click <strong>Test discovery</strong>, then open the login page in a private window — a <strong>Sign in with Microsoft</strong> button should
            appear.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          This server needs outbound HTTPS to <code>login.microsoftonline.com</code>. It's in the outbound list above once the issuer is set.
        </p>
        {discovery.error && <Hint tone="red">{discovery.error}</Hint>}
        {discovery.result && (
          <div className="space-y-1 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <StateIcon state={discovery.result.ok ? "green" : "red"} />
              <span className="font-medium">{discovery.result.ok ? "Identity provider reachable" : "Discovery failed"}</span>
              <span className="text-xs text-muted-foreground">{discovery.result.detail}</span>
            </div>
            {discovery.result.issuer && <p className="break-all text-xs text-muted-foreground">Issuer: {discovery.result.issuer}</p>}
            {discovery.result.endpointHosts.length > 0 && (
              <p className="text-xs text-muted-foreground">Sign-in uses: {discovery.result.endpointHosts.join(", ")}</p>
            )}
            {discovery.result.hint && <p className="text-xs">{discovery.result.hint}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function NetworkStatusPanel() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getServerStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <StatusCard report={report} loading={loading} error={error} onRefresh={load} />
      {report && (
        <>
          <ReachabilityCard report={report} />
          <DeploymentGuide report={report} />
          <EntraCard report={report} />
        </>
      )}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import * as api from "../lib/api";
import type { SiteInfo } from "../lib/api";
import { toDraft, toSettings, type SiteDraft } from "../lib/public-site";
import { SiteDnsPanel } from "./SiteDnsPanel";

/**
 * Public site settings (CU-wdqcq05jhm) — owner / nest admin / server admin.
 *
 * A public Reader Mode nest is also published as a static, crawlable docs
 * site. This is where its owner gives it a domain, page URLs, redirects and
 * the search / AI-crawler settings. Server validation is the real gate.
 */

export interface PublicSiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nestId: string;
}

export function PublicSiteDialog({ open, onOpenChange, nestId }: PublicSiteDialogProps) {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [draft, setDraft] = useState<SiteDraft | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathEdits, setPathEdits] = useState<Record<string, string>>({});
  const [pageFilter, setPageFilter] = useState("");

  const apply = (next: SiteInfo) => {
    setInfo(next);
    setDraft(toDraft(next.settings));
    setDomain(next.domain ?? "");
    setPathEdits({});
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.getNestSite(nestId).then(apply, (e) => setError(e?.message || "Could not load site settings"));
  }, [open, nestId]);

  const run = async (label: string, fn: () => Promise<SiteInfo>, success?: string) => {
    setBusy(label);
    setError(null);
    try {
      apply(await fn());
      if (success) toast.success(success);
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const save = (d: SiteDraft) => {
    const out = toSettings(d);
    // A line the form can't read is reported, never dropped on the way to the server.
    if ("error" in out) return setError(out.error);
    void run("save", () => api.updateNestSite(nestId, { settings: out.settings }), "Site settings saved");
  };

  const set = <K extends keyof SiteDraft>(k: K, v: SiteDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const pages = (info?.pages ?? []).filter(
    (p) => !pageFilter || `${p.title} ${p.path}`.toLowerCase().includes(pageFilter.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Public site</DialogTitle>
          <DialogDescription>
            This nest is published as a fast, search-engine-ready docs site:
            every approved page as plain HTML, with a sitemap, llms.txt and a
            Markdown copy for AI agents. Drafts never appear.
          </DialogDescription>
        </DialogHeader>

        {!info || !draft ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            {error ?? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </>
            )}
          </div>
        ) : (
          <div className="-mx-4 min-h-0 flex-1 space-y-5 overflow-y-auto border-y px-4 py-4 sm:-mx-6 sm:px-6">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
              <Globe className="h-4 w-4 text-muted-foreground" />
              {info.live && info.url ? (
                <>
                  <span className="font-medium">Live at</span>
                  <a href={info.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-primary underline">
                    {info.url} <ExternalLink className="h-3 w-3" />
                  </a>
                </>
              ) : (
                <span className="text-muted-foreground">{info.reason}</span>
              )}
            </div>

            <Section title="Custom domain">
              <p className="text-xs text-muted-foreground">
                Serve the site at your own domain, e.g. <code>docs.example.com</code>. Search engines then see one
                address per page; the old address redirects.
              </p>
              <div className="flex gap-2">
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="docs.example.com" className="h-9" aria-label="Custom domain" />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  disabled={!!busy || domain.trim() === (info.domain ?? "")}
                  onClick={() => void run("domain", () => api.updateNestSite(nestId, { domain: domain.trim() || null }), domain.trim() ? "Domain saved — now add the DNS records" : "Domain removed")}
                >
                  {busy === "domain" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {domain.trim() ? "Save" : "Remove"}
                </Button>
              </div>
              {info.domain && info.dns && (
                <SiteDnsPanel
                  host={info.domain}
                  verified={info.domain_verified}
                  intro="Add these records at your DNS provider:"
                  records={[
                    ...(info.dns.txt ? [{ type: "TXT", ...info.dns.txt }] : []),
                    ...(info.dns.cname ? [{ type: "CNAME", name: info.domain, value: info.dns.cname }] : []),
                  ]}
                  note={info.dns.cname ? undefined : "Point the domain at this server: ask your server admin for the CNAME target and HTTPS setup."}
                  busy={!!busy}
                  verifying={busy === "verify"}
                  onVerify={() => void run("verify", () => api.verifyNestSiteDomain(nestId), "Domain verified")}
                />
              )}
            </Section>

            <Section title="Search & sharing">
              <Field label="Site name" hint="Shown in titles and the header. Defaults to the branding title, then the nest name.">
                <Input value={draft.title} onChange={(e) => set("title", e.target.value)} maxLength={120} className="h-9" />
              </Field>
              <Field label="Description" hint="The home page description in search results and llms.txt.">
                <Textarea value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={300} rows={2} />
              </Field>
              <Field label="Share image URL" hint="1200×630 image shown when a page is shared. Defaults to the branding banner, then the logo.">
                <Input value={draft.og_image_url} onChange={(e) => set("og_image_url", e.target.value)} placeholder="https://…" className="h-9" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Organization">
                  <Input value={draft.organization_name} onChange={(e) => set("organization_name", e.target.value)} className="h-9" />
                </Field>
                <Field label="Organization website">
                  <Input value={draft.organization_url} onChange={(e) => set("organization_url", e.target.value)} placeholder="https://…" className="h-9" />
                </Field>
                <Field label="Organization logo URL">
                  <Input value={draft.organization_logo_url} onChange={(e) => set("organization_logo_url", e.target.value)} placeholder="https://…" className="h-9" />
                </Field>
                <Field label="X / Twitter handle">
                  <Input value={draft.twitter_site} onChange={(e) => set("twitter_site", e.target.value)} placeholder="@acme" className="h-9" />
                </Field>
              </div>
              <Field label="Profiles" hint="One URL per line (GitHub, LinkedIn…). Tells search engines these accounts are yours.">
                <Textarea value={draft.same_as} onChange={(e) => set("same_as", e.target.value)} rows={2} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Google verification">
                  <Input value={draft.google_site_verification} onChange={(e) => set("google_site_verification", e.target.value)} className="h-9 font-mono text-xs" />
                </Field>
                <Field label="Bing verification">
                  <Input value={draft.bing_site_verification} onChange={(e) => set("bing_site_verification", e.target.value)} className="h-9 font-mono text-xs" />
                </Field>
                <Field label="Language">
                  <Input value={draft.language} onChange={(e) => set("language", e.target.value)} placeholder="en" className="h-9" />
                </Field>
              </div>
            </Section>

            <Section title="AI & crawlers">
              <Toggle label="Allow AI training" hint="AI search and assistants can always read and cite the site; this decides whether models may also train on it." checked={draft.ai_training} onChange={(v) => set("ai_training", v)} />
              <Toggle label="“Copy page” and “Open in ChatGPT / Claude”" hint="Buttons on every page that hand it to an AI assistant." checked={draft.ai_actions} onChange={(v) => set("ai_actions", v)} />
              <Toggle label="Notify search engines on change" hint="Pings IndexNow (Bing, Yandex and others) when pages change." checked={draft.indexnow} onChange={(v) => set("indexnow", v)} />
              <Toggle label="Hide from search engines" hint="Keep the site out of search results entirely (staging or private betas)." checked={draft.noindex} onChange={(v) => set("noindex", v)} />
            </Section>

            <Section title="Page URLs">
              <p className="text-xs text-muted-foreground">
                Give a page its own address. The old address keeps working as a permanent redirect, so links and rankings carry over.
              </p>
              {info.pages.length > 8 && (
                <Input value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} placeholder="Filter pages" className="h-8" aria-label="Filter pages" />
              )}
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {info.pages.length === 0 && <p className="text-xs text-muted-foreground">Pages appear here once the site is live.</p>}
                {pages.map((p) => {
                  const edit = pathEdits[p.node_id];
                  const value = edit ?? p.path;
                  return (
                    <div key={p.node_id} className="flex items-center gap-2 text-sm">
                      <span className="w-40 shrink-0 truncate" title={p.title}>{p.title}</span>
                      <span className="text-muted-foreground">/</span>
                      <Input
                        value={value}
                        disabled={p.path === "" || !!busy}
                        onChange={(e) => setPathEdits((m) => ({ ...m, [p.node_id]: e.target.value }))}
                        className="h-8 font-mono text-xs"
                        aria-label={`URL for ${p.title}`}
                      />
                      {edit !== undefined && edit !== p.path ? (
                        <Button size="sm" variant="outline" className="h-8" disabled={!!busy} onClick={() => void run(`path:${p.node_id}`, () => api.setNestSitePageUrl(nestId, p.node_id, edit), "Page URL saved")}>
                          Save
                        </Button>
                      ) : p.custom ? (
                        <Button size="sm" variant="ghost" className="h-8" disabled={!!busy} title="Go back to the address from the folder structure" onClick={() => void run(`path:${p.node_id}`, () => api.setNestSitePageUrl(nestId, p.node_id, null), "Page URL reset")}>
                          Reset
                        </Button>
                      ) : (
                        <span className="w-14" />
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Redirects">
              <Field label="One per line: old path, then new path or https:// URL" hint="For pages that moved before this site existed, or addresses you want to keep alive. An https:// URL must be on your verified domain or verified public URL.">
                <Textarea value={draft.redirects} onChange={(e) => set("redirects", e.target.value)} rows={3} placeholder="/old/setup /guides/setup" className="font-mono text-xs" />
              </Field>
            </Section>

            <Section title="Advanced">
              <Field label="Serve behind your own proxy" hint="If you proxy the site under your main domain (e.g. https://example.com/docs), enter that URL. Canonical URLs then point there.">
                <Input value={draft.public_url} onChange={(e) => set("public_url", e.target.value)} placeholder="https://example.com/docs" className="h-9" />
              </Field>
              {info.settings.public_url && info.public_url_dns && (
                <SiteDnsPanel
                  host={info.settings.public_url}
                  verified={info.public_url_verified}
                  intro="The site uses this URL only after you prove you control its domain. Keep this record at your DNS provider:"
                  records={[{ type: "TXT", ...info.public_url_dns }]}
                  busy={!!busy}
                  verifying={busy === "verify-url"}
                  onVerify={() => void run("verify-url", () => api.verifyNestSitePublicUrl(nestId), "Public URL verified")}
                />
              )}
            </Section>
          </div>
        )}

        {error && info && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!busy}>
            Close
          </Button>
          <Button disabled={!draft || !!busy} onClick={() => draft && save(draft)}>
            {busy === "save" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-[13px] font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

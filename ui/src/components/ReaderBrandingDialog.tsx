import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as api from "../lib/api";
import {
  BRANDING_LIMITS,
  brandingToCssVars,
  contrastRatio,
  cssUrl,
  isBranded,
  normalizeHex,
  readableForeground,
  validateBrandingDraft,
  type NestBranding,
} from "../lib/branding";
import hootieIcon from "../assets/hootie.svg";

/**
 * Reader branding settings (CU-wdqcq02ptm) — owner / nest admin / server admin.
 *
 * The form edits a draft; the preview on the right renders that draft through
 * the same brandingToCssVars the live reader uses, so what you see is what a
 * visitor gets. Save sends the whole draft (the API replaces branding
 * wholesale); "Reset to default" clears it. Server validation is the real
 * gate — the inline checks here only save a round trip.
 */

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

type Draft = { [K in Exclude<keyof NestBranding, "hide_powered_by">]-?: string } & { hide_powered_by: boolean };

function toDraft(b: NestBranding | null | undefined): Draft {
  return {
    logo_url: b?.logo_url ?? "",
    banner_url: b?.banner_url ?? "",
    banner_headline: b?.banner_headline ?? "",
    banner_subtext: b?.banner_subtext ?? "",
    accent_color: b?.accent_color ?? "",
    header_bg_color: b?.header_bg_color ?? "",
    page_tint_color: b?.page_tint_color ?? "",
    site_title: b?.site_title ?? "",
    footer_text: b?.footer_text ?? "",
    footer_link_url: b?.footer_link_url ?? "",
    footer_link_label: b?.footer_link_label ?? "",
    favicon_url: b?.favicon_url ?? "",
    hide_powered_by: !!b?.hide_powered_by,
  };
}

/**
 * Draft → API body: empty strings become absent; nothing left → null (clear).
 *
 * `hide_powered_by` is only ever sent as `true`, never as an explicit `false`.
 * That is deliberate: for the server admin an absent flag and `false` mean the
 * same thing (the server reads absent as false), and for anyone else leaving it
 * out is what makes the server KEEP an admin-set `true` instead of treating the
 * form's default as an attempt to turn white-labelling off.
 */
function toBody(d: Draft): NestBranding | null {
  const out: NestBranding = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === "string" && v.trim() !== "") (out as any)[k] = v.trim();
  }
  if (d.hide_powered_by) out.hide_powered_by = true;
  return isBranded(out) ? out : null;
}

export interface ReaderBrandingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nestId: string;
  nestName: string;
  branding: NestBranding | null;
  /** Server admin — the only caller who may hide "Powered by ContextNest". */
  isServerAdmin: boolean;
  onSaved: (branding: NestBranding | null) => void;
}

export function ReaderBrandingDialog({
  open,
  onOpenChange,
  nestId,
  nestName,
  branding,
  isServerAdmin,
  onSaved,
}: ReaderBrandingDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(branding));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(toDraft(branding));
      setServerError(null);
    }
  }, [open, branding]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const errors = useMemo(() => validateBrandingDraft(draft, nestId), [draft, nestId]);
  const hasErrors = Object.keys(errors).length > 0;

  const save = async (body: NestBranding | null) => {
    setSaving(true);
    setServerError(null);
    try {
      const res = await api.setNestBranding(nestId, body);
      onSaved(res.branding);
      toast.success(res.branding ? "Branding saved" : "Branding reset to default");
      onOpenChange(false);
    } catch (e: any) {
      setServerError(e?.message || "Could not save branding");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[1040px]">
        <DialogHeader>
          <DialogTitle>Reader branding</DialogTitle>
          <DialogDescription>
            How this nest looks to people reading it in reader mode and on its
            published /p links. Colors adjust their text automatically so
            everything stays readable.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="min-w-0 space-y-5">
            <Section title="Identity">
              <TextField label="Site title" hint={`Shown in the header and the browser tab. Defaults to “${nestName}”.`} value={draft.site_title} max={BRANDING_LIMITS.site_title} error={errors.site_title} onChange={(v) => set("site_title", v)} placeholder={nestName} />
              <ImageField label="Logo" hint="Header logo. Falls back to the server logo." nestId={nestId} value={draft.logo_url} error={errors.logo_url} onChange={(v) => set("logo_url", v)} />
              <ImageField label="Favicon" hint="Browser tab icon while reading. Optional." nestId={nestId} value={draft.favicon_url} error={errors.favicon_url} onChange={(v) => set("favicon_url", v)} />
            </Section>

            <Section title="Banner">
              <ImageField label="Banner image" hint="Wide image at the top of the home page. Around 1600×400 works well." nestId={nestId} value={draft.banner_url} error={errors.banner_url} onChange={(v) => set("banner_url", v)} />
              <TextField label="Headline" value={draft.banner_headline} max={BRANDING_LIMITS.banner_headline} error={errors.banner_headline} onChange={(v) => set("banner_headline", v)} placeholder="Welcome to the Acme handbook" />
              <TextField label="Subtext" value={draft.banner_subtext} max={BRANDING_LIMITS.banner_subtext} error={errors.banner_subtext} onChange={(v) => set("banner_subtext", v)} placeholder="Policies, playbooks and how we work." />
            </Section>

            <Section title="Colors">
              <ColorField label="Accent" hint="Links, the current page, buttons, and the banner when it has no image." value={draft.accent_color} error={errors.accent_color} onChange={(v) => set("accent_color", v)} />
              <ColorField label="Header background" value={draft.header_bg_color} error={errors.header_bg_color} onChange={(v) => set("header_bg_color", v)} />
              <ColorField label="Page tint" hint="A light wash of this color behind the reader. Optional." value={draft.page_tint_color} error={errors.page_tint_color} onChange={(v) => set("page_tint_color", v)} />
            </Section>

            <Section title="Footer">
              <TextField label="Footer text" value={draft.footer_text} max={BRANDING_LIMITS.footer_text} error={errors.footer_text} onChange={(v) => set("footer_text", v)} placeholder="© Acme Corp" />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Footer link" value={draft.footer_link_url} error={errors.footer_link_url} onChange={(v) => set("footer_link_url", v)} placeholder="https://acme.example.com" />
                <TextField label="Link label" value={draft.footer_link_label} max={BRANDING_LIMITS.footer_link_label} error={errors.footer_link_label} onChange={(v) => set("footer_link_label", v)} placeholder="acme.example.com" />
              </div>
              {isServerAdmin ? (
                <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="brand-hide-powered" className="text-sm font-medium">Hide “Powered by ContextNest”</Label>
                    <p className="text-xs text-muted-foreground">Server admin only. Also hides “Secured by PromptOwl” on /p pages.</p>
                  </div>
                  <Switch id="brand-hide-powered" checked={draft.hide_powered_by} onCheckedChange={(v) => set("hide_powered_by", v)} />
                </div>
              ) : (
                draft.hide_powered_by && (
                  <p className="text-xs text-muted-foreground">“Powered by ContextNest” is hidden by the server admin.</p>
                )
              )}
            </Section>
          </div>

          <div className="min-w-0 md:sticky md:top-0 md:self-start">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live preview</p>
            <BrandingPreview draft={draft} nestName={nestName} />
            <ContrastNotes draft={draft} />
          </div>
        </div>

        {serverError && (
          <p role="alert" className="text-sm text-destructive">{serverError}</p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            className="mr-auto gap-1.5"
            onClick={() => void save(null)}
            disabled={saving || !isBranded(branding)}
            title="Remove all branding — the reader goes back to the default look"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to default
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save(toBody(draft))} disabled={saving || hasErrors}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save branding
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

function FieldShell({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[13px] font-medium">{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

let fieldSeq = 0;
function useFieldId(prefix: string) {
  const ref = useRef<string>();
  if (!ref.current) ref.current = `${prefix}-${++fieldSeq}`;
  return ref.current;
}

function TextField({ label, hint, value, onChange, error, max, placeholder }: { label: string; hint?: string; value: string; onChange: (v: string) => void; error?: string; max?: number; placeholder?: string }) {
  const id = useFieldId("brand-text");
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={max} placeholder={placeholder} aria-invalid={!!error} className="h-9" />
    </FieldShell>
  );
}

function ColorField({ label, hint, value, onChange, error }: { label: string; hint?: string; value: string; onChange: (v: string) => void; error?: string }) {
  const id = useFieldId("brand-color");
  const hex = normalizeHex(value);
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} color picker`}
          value={hex ?? "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
        />
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="#1e40af" maxLength={7} aria-invalid={!!error} className="h-9 w-32 font-mono" />
        {value && (
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-muted-foreground" onClick={() => onChange("")}>
            Clear
          </Button>
        )}
      </div>
    </FieldShell>
  );
}

function ImageField({ label, hint, value, onChange, error, nestId }: { label: string; hint?: string; value: string; onChange: (v: string) => void; error?: string; nestId: string }) {
  const id = useFieldId("brand-img");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
      toast.error("Use a PNG, JPG, GIF or WebP image");
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadAsset(nestId, file);
      onChange(res.url);
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const showThumb = value && !error;
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={id}>
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
          {showThumb ? <img src={value} alt="" className="h-full w-full object-contain" /> : <ImagePlus className="h-4 w-4 text-muted-foreground" />}
        </div>
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Upload, or paste an https:// image link" aria-invalid={!!error} className="h-9 min-w-0 flex-1" />
        <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Upload"}
        </Button>
        {value && (
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onChange("")}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </FieldShell>
  );
}

/**
 * A miniature of the branded reader: header, banner, nav + article card,
 * footer — driven by the same variables the real reader sets.
 */
function BrandingPreview({ draft, nestName }: { draft: Draft; nestName: string }) {
  const b = toBody(draft) ?? {};
  // Invalid values are simply ignored by the helper, like the server refuses them.
  const vars = brandingToCssVars(b, "light") as CSSProperties;
  const header = normalizeHex(draft.header_bg_color);
  const accent = normalizeHex(draft.accent_color);
  const title = draft.site_title.trim() || nestName;
  const hasBanner = !!(draft.banner_url.trim() || draft.banner_headline.trim());
  return (
    <div data-reader-branded="" style={vars} className="overflow-hidden rounded-lg border bg-background text-foreground shadow-sm" aria-hidden>
      <div
        className="flex h-11 items-center gap-2 border-b bg-card px-3"
        style={header ? { backgroundColor: "var(--reader-header-bg)", color: "var(--reader-header-fg)", borderColor: "transparent" } : undefined}
      >
        <img src={draft.logo_url.trim() || hootieIcon} alt="" className="h-6 w-auto max-w-[5rem] object-contain" />
        <span className="truncate text-[13px] font-semibold">{title}</span>
        <span className="ml-auto rounded border border-input bg-background px-2 py-0.5 text-[10px] text-foreground">Login</span>
      </div>
      <div className="space-y-2 p-3">
        {hasBanner && (
          <div
            className="relative flex h-20 flex-col justify-end overflow-hidden rounded-md px-3 py-2"
            style={
              draft.banner_url.trim()
                ? { backgroundImage: cssUrl(draft.banner_url.trim()), backgroundSize: "cover", backgroundPosition: "center", color: "#fff" }
                : { background: accent ? "var(--reader-accent)" : "hsl(var(--primary))", color: accent ? "var(--reader-accent-fg)" : "hsl(var(--primary-foreground))" }
            }
          >
            {draft.banner_url.trim() && <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/25 to-black/0" />}
            {draft.banner_url.trim() && accent && <div className="absolute inset-x-0 bottom-0 h-1" style={{ background: "var(--reader-accent)" }} />}
            {draft.banner_headline && <p className="relative truncate text-sm font-semibold">{draft.banner_headline}</p>}
            {draft.banner_subtext && <p className="relative truncate text-[11px] opacity-90">{draft.banner_subtext}</p>}
          </div>
        )}
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
          <aside className="space-y-0.5 rounded-md border bg-card p-2 text-[11px]">
            <button type="button" tabIndex={-1} aria-current="page" className="block w-full truncate rounded bg-accent px-1.5 py-0.5 text-left font-medium text-foreground">Welcome</button>
            <span className="block truncate px-1.5 py-0.5 text-muted-foreground">Getting started</span>
            <span className="block truncate px-1.5 py-0.5 text-muted-foreground">Policies</span>
          </aside>
          <div className="rounded-md border bg-card p-3 text-[11px] leading-relaxed">
            <p className="text-sm font-semibold">Welcome</p>
            <div className="prose prose-sm max-w-none text-[11px]">
              <p className="my-1">Read the <a href="#preview">onboarding guide</a> first.</p>
            </div>
            <span className="mt-2 inline-block rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">Next page</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-3 border-t px-3 py-2 text-[10px] text-muted-foreground">
        {draft.footer_text && <span>{draft.footer_text}</span>}
        {draft.footer_link_url && <span style={{ color: "var(--reader-accent-text, inherit)" }} className="underline">{draft.footer_link_label || draft.footer_link_url}</span>}
        {!draft.hide_powered_by && <span>Powered by ContextNest</span>}
      </div>
    </div>
  );
}

/** Plain-language contrast readout for the colors that carry text. */
function ContrastNotes({ draft }: { draft: Draft }) {
  const notes: string[] = [];
  const accent = normalizeHex(draft.accent_color);
  if (accent) {
    const fg = readableForeground(accent);
    notes.push(`Text on the accent: ${fg === "#000000" ? "black" : "white"} (${contrastRatio(fg, accent).toFixed(1)}:1, meets WCAG AA)`);
    const vars = brandingToCssVars({ accent_color: accent, page_tint_color: draft.page_tint_color }, "light");
    if (vars["--reader-accent-text"] !== accent) notes.push("Links use a deeper shade of the accent so they stay readable.");
  }
  const header = normalizeHex(draft.header_bg_color);
  if (header) {
    const fg = readableForeground(header);
    notes.push(`Header text: ${fg === "#000000" ? "black" : "white"} (${contrastRatio(fg, header).toFixed(1)}:1, meets WCAG AA)`);
  }
  if (!notes.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

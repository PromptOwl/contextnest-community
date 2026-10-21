/**
 * Public site settings form (CU-wdqcq05jhm): the draft the dialog edits and the
 * settings it sends. Server validation is the real gate; this only refuses
 * lines it can't read, so nothing the owner typed is dropped silently.
 */
import type { SiteSettings } from "./api";

export type SiteDraft = {
  [K in keyof SiteSettings]-?: SiteSettings[K] extends boolean | undefined ? boolean : string;
};

export function toDraft(s: SiteSettings): SiteDraft {
  return {
    title: s.title ?? "",
    description: s.description ?? "",
    public_url: s.public_url ?? "",
    og_image_url: s.og_image_url ?? "",
    organization_name: s.organization_name ?? "",
    organization_url: s.organization_url ?? "",
    organization_logo_url: s.organization_logo_url ?? "",
    same_as: (s.same_as ?? []).join("\n"),
    twitter_site: s.twitter_site ?? "",
    google_site_verification: s.google_site_verification ?? "",
    bing_site_verification: s.bing_site_verification ?? "",
    language: s.language ?? "",
    noindex: !!s.noindex,
    ai_training: s.ai_training !== false,
    ai_actions: s.ai_actions !== false,
    indexnow: s.indexnow !== false,
    redirects: (s.redirects ?? []).map((r) => `${r.from} ${r.to}`).join("\n"),
  };
}

/** "old new" per line. Blank lines are skipped; any other line must be exactly two parts. */
export function parseRedirects(text: string): { redirects: Array<{ from: string; to: string }>; bad: string[] } {
  const redirects: Array<{ from: string; to: string }> = [];
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 2) redirects.push({ from: parts[0], to: parts[1] });
    else bad.push(line.trim());
  }
  return { redirects, bad };
}

/** The settings to save, or the message to show instead. */
export function toSettings(d: SiteDraft): { settings: SiteSettings } | { error: string } {
  const out: SiteSettings = {};
  for (const k of [
    "title", "description", "public_url", "og_image_url", "organization_name", "organization_url",
    "organization_logo_url", "twitter_site", "google_site_verification", "bing_site_verification", "language",
  ] as const) {
    const v = d[k].trim();
    if (v) out[k] = v;
  }
  const sameAs = d.same_as.split(/\s+/).filter(Boolean);
  if (sameAs.length) out.same_as = sameAs;
  if (d.noindex) out.noindex = true;
  if (!d.ai_training) out.ai_training = false;
  if (!d.ai_actions) out.ai_actions = false;
  if (!d.indexnow) out.indexnow = false;
  const { redirects, bad } = parseRedirects(d.redirects);
  if (bad.length) {
    return { error: `Each redirect needs an old path and a new path, separated by a space. Fix: ${bad.map((l) => `"${l}"`).join(", ")}` };
  }
  if (redirects.length) out.redirects = redirects;
  return { settings: out };
}

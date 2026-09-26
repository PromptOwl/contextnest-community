import type { NestBranding } from "@/lib/branding";

/**
 * The shell footer for a branded public reader (CU-wdqcq02ptm): the owner's
 * footer line and link, then a quiet "Powered by ContextNest" — which only the
 * server admin can switch off (hide_powered_by). Replaces the build-version
 * footnote, which means nothing to a visitor of someone else's docs site.
 */
export function ReaderBrandFooter({ branding, className = "" }: { branding: NestBranding; className?: string }) {
  const { footer_text: text, footer_link_url: href, footer_link_label: label, hide_powered_by } = branding;
  if (!text && !href && hide_powered_by) return null;
  return (
    <footer
      className={`${className} flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-4 text-center text-xs text-muted-foreground`}
      data-testid="reader-brand-footer"
    >
      {text && <span>{text}</span>}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
          style={{ color: "var(--reader-accent-text, inherit)" }}
        >
          {label || href.replace(/^https:\/\//, "").replace(/\/$/, "")}
        </a>
      )}
      {!hide_powered_by && (
        <a
          href="https://promptowl.ai/contextnest/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground/80 hover:text-foreground"
        >
          Powered by ContextNest
        </a>
      )}
    </footer>
  );
}

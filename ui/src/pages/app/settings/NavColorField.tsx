/**
 * Server settings → Basic → Navigation color (PO-1430).
 *
 * A curated palette, a custom hex (validated inline), and a live preview of
 * the rail drawn with the same tokens the real rail uses (navRail), so what
 * the admin sees here is what everyone gets after Save.
 */
import { Check, Inbox, LayoutGrid, Pencil, Search, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { normalizeHex } from "../../../lib/branding";
import { DEFAULT_NAV_COLOR, NAV_PALETTE, RAIL_IDLE_TEXT, navColorError, navRail, navRailStyle } from "../../../lib/nav-color";

export function NavColorField({
  value,
  error,
  logoUrl,
  onChange,
}: {
  /** The draft: a hex, or "" for the default. */
  value: string;
  /** The server's reason the last save was refused. */
  error?: string;
  logoUrl: string;
  onChange: (v: string) => void;
}) {
  const inlineError = navColorError(value);
  const shown = inlineError ?? error;
  // An invalid draft previews the color last typed validly — i.e. the default.
  const valid = inlineError ? null : normalizeHex(value.trim());
  const rail = navRail(valid);
  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_15rem]" data-testid="settings-nav-color">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label id="nav-color-palette-label">Color</Label>
          <div
            role="radiogroup"
            aria-labelledby="nav-color-palette-label"
            className="flex flex-wrap gap-2"
          >
            {NAV_PALETTE.map((p) => {
              const selected = p.hex ? valid === p.hex : !valid;
              const swatch = p.hex ?? DEFAULT_NAV_COLOR;
              return (
                <button
                  key={p.name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={p.hex ? `${p.name} ${p.hex}` : `${p.name} (default)`}
                  title={p.hex ? `${p.name} ${p.hex}` : `${p.name} (default)`}
                  onClick={() => onChange(p.hex ?? "")}
                  className={cn(
                    "relative flex h-8 w-8 items-center justify-center rounded-md border border-black/10 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                  )}
                  style={{ backgroundColor: swatch }}
                  data-testid={`nav-color-swatch-${p.name.toLowerCase()}`}
                >
                  {selected && <Check className="h-4 w-4" style={{ color: navRail(p.hex).colors.foreground }} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nav-color-hex">Custom hex</Label>
          <div className="flex items-start gap-2">
            {/* The native picker writes the same field; the hex box stays the source of truth. */}
            <input
              type="color"
              aria-label="Pick a custom color"
              value={valid ?? DEFAULT_NAV_COLOR}
              onChange={(e) => onChange(e.target.value)}
              className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
              data-testid="nav-color-picker"
            />
            <div className="flex-1">
              <Input
                id="nav-color-hex"
                value={value}
                placeholder={`${DEFAULT_NAV_COLOR} (default)`}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!shown}
                aria-describedby="nav-color-help"
                className={cn("font-mono", shown && "border-destructive focus-visible:ring-destructive")}
                autoComplete="off"
                spellCheck={false}
                data-testid="nav-color-hex"
              />
              {shown && (
                <p className="mt-1 text-xs text-destructive" data-testid="nav-color-error">
                  {shown}
                </p>
              )}
            </div>
          </div>
          <p id="nav-color-help" className="text-xs text-muted-foreground">
            The left navigation for everyone on this server. Text and icon
            colors are picked for you so they stay readable.
            {valid && (
              <>
                {" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onChange("")}>
                  Reset to default
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Preview: a slice of the rail, built with the real rail's tokens. */}
      <figure className="space-y-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">Preview</figcaption>
        <div
          className="overflow-hidden rounded-lg border text-sm text-foreground shadow-sm"
          style={navRailStyle(valid)}
          aria-hidden
          data-testid="nav-color-preview"
          data-nav-color={rail.custom ? rail.background : "default"}
        >
          <div className="flex h-12 items-center gap-2 border-b border-border px-3">
            <img src={logoUrl} alt="" className="h-6 w-6 rounded bg-white object-contain p-0.5" />
            <span className="font-semibold">ContextNest</span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              Community
            </Badge>
          </div>
          <div className="space-y-0.5 p-2">
            <div className="relative mb-1.5">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <div className="h-7 rounded-md border border-border bg-background pl-7 text-xs leading-7 text-muted-foreground">
                Filter nests
              </div>
            </div>
            <PreviewRow icon={LayoutGrid} label="All nests" />
            <PreviewRow icon={Inbox} label="My Work" active count={3} />
            <PreviewRow icon={Pencil} label="My Drafts" />
            <PreviewRow icon={Users} label="Teams" />
            <p className="px-2.5 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">Workspace</p>
          </div>
        </div>
      </figure>
    </div>
  );
}

function PreviewRow({
  icon: Icon,
  label,
  active,
  count,
}: {
  icon: typeof Inbox;
  label: string;
  active?: boolean;
  count?: number;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5",
        active ? "bg-muted font-medium text-foreground" : RAIL_IDLE_TEXT,
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
      {count ? (
        <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
          {count}
        </span>
      ) : null}
    </div>
  );
}

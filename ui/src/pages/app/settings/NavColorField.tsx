/**
 * Server settings → Basic → Navigation color (PO-1430).
 *
 * A curated palette, a custom hex (validated inline), and a live preview of
 * the rail built from the real rail's parts (RailParts, WorkShortcuts) on the
 * same tokens (navRail), so what the admin sees here is what everyone gets
 * after Save, and the preview can't drift from the rail.
 */
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { normalizeHex } from "../../../lib/branding";
import { reads } from "../../../lib/queries";
import { useAuth } from "../../../auth/AuthContext";
import { VisibilityGlyph, WorkShortcuts } from "@/components/DocumentSidebar";
import {
  ACCOUNT_TRIGGER_SIDEBAR,
  AccountTriggerBody,
  RailBrand,
  RailFooter,
  RailNestHeading,
  RailRow,
} from "@/components/rail/RailParts";
import { DEFAULT_NAV_COLOR, NAV_PALETTE, navColorError, navRail, navRailStyle } from "../../../lib/nav-color";

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
  const { isAdmin, authMode, adminStatus } = useAuth();
  const displayName = adminStatus?.me?.name?.trim() || adminStatus?.me?.email || "You";
  // The admin's own nests (the rail's list, already cached), a few of them.
  const nests = useQuery({ ...reads.nestList() });
  const list: any[] = nests.data?.nests ?? [];
  const sampleNests = (list.length ? list : [{ id: "sample", name: "Your nest", visibility: "private" }])
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, 3);
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

      {/* Preview: the real rail's parts (RailParts + WorkShortcuts) on the
          chosen tokens, so it shows exactly what everyone will see. inert:
          a picture, not a second set of controls. */}
      <figure className="space-y-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">Preview</figcaption>
        <div
          className="flex h-[26rem] flex-col overflow-hidden rounded-lg border text-sm text-foreground shadow-sm"
          style={navRailStyle(valid)}
          aria-hidden
          {...{ inert: "" }}
          data-testid="nav-color-preview"
          data-nav-color={rail.custom ? rail.background : "default"}
        >
          <RailBrand logoUrl={logoUrl} preview />
          <WorkShortcuts active={null} isAdmin={isAdmin} isSuperadmin={isAdmin && authMode !== "open"} preview />
          <RailRow icon={LayoutGrid} label="All nests" active className="mx-2 mt-1.5 w-auto" />
          <div className="min-h-0 flex-1 overflow-hidden px-2 pb-4 pt-1">
            {sampleNests.map((n: any, i: number) => (
              <div key={n.id ?? i} className="mb-1">
                <RailNestHeading
                  name={n.name}
                  open={false}
                  current={false}
                  glyphs={<VisibilityGlyph visibility={n.visibility} />}
                />
              </div>
            ))}
          </div>
          <RailFooter preview>
            <RailRow icon={BookOpen} label="Docs" />
            <Button variant="ghost" size="sm" className={ACCOUNT_TRIGGER_SIDEBAR}>
              <AccountTriggerBody displayName={displayName} inSidebar />
            </Button>
          </RailFooter>
        </div>
      </figure>
    </div>
  );
}

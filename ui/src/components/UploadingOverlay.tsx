/**
 * "Upload in progress" card — big, centred and high-contrast so a slow upload
 * (a large PDF) can't be mistaken for an idle page. It lets clicks through, so
 * a hung request never locks the rest of the app.
 */
import { Loader2 } from "lucide-react";

export function UploadingOverlay({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
      data-testid="uploading-overlay"
    >
      <div className="flex min-w-[16rem] max-w-sm flex-col items-center gap-3 rounded-xl border bg-card px-8 py-6 text-center shadow-xl ring-1 ring-primary/20">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-base font-semibold text-foreground">{title}</div>
        {detail && <div className="break-all text-sm text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

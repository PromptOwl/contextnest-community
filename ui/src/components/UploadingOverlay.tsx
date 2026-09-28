/**
 * Full-screen "upload in progress" card — big, centred and high-contrast so a
 * slow upload (a large PDF) can't be mistaken for an idle page.
 */
import { Loader2 } from "lucide-react";

export function UploadingOverlay({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      data-testid="uploading-overlay"
    >
      <div className="flex min-w-[16rem] max-w-sm flex-col items-center gap-3 rounded-xl border bg-card px-8 py-6 text-center shadow-xl">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-base font-semibold text-foreground">{title}</div>
        {detail && <div className="break-all text-sm text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

/**
 * A sheet (PO-1200, AC-C3-05, AC-C3-10): the channel list from the left on a
 * phone, the thread from the right below 1100 px. Radix Dialog underneath,
 * so focus is trapped, Escape closes it and focus returns to what opened it.
 * Motion is `pane-open`: a 160 ms slide when it opens, a fade when it closes,
 * and a cut when the person prefers reduced motion.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ChatSheet({
  open,
  onOpenChange,
  side,
  title,
  children,
  className,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  /** Read by screen readers; the sheet's own header is the visible title. */
  title: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          data-testid={testId}
          className={cn(
            "fixed inset-y-0 z-50 flex w-[min(100vw,22rem)] flex-col bg-background shadow-2xl outline-none duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
            side === "left"
              ? "left-0 border-r data-[state=open]:slide-in-from-left"
              : "right-0 border-l data-[state=open]:slide-in-from-right",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The close control a sheet's own header renders. */
export function SheetClose({ label = "Close" }: { label?: string }) {
  return (
    <DialogPrimitive.Close
      aria-label={label}
      title={`${label} (Esc)`}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <X className="h-4 w-4" aria-hidden />
    </DialogPrimitive.Close>
  );
}

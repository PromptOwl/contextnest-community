import * as React from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { copyTextWithToast } from "@/lib/clipboard";

export interface CopyButtonProps
  extends Omit<ButtonProps, "onClick" | "children" | "asChild"> {
  /** What lands on the clipboard. */
  text: string;
  /** Visible label; omit for an icon-only button. Reads "Copied" briefly after a copy. */
  label?: React.ReactNode;
  /** Icon shown before a copy. Defaults to the copy glyph. */
  icon?: LucideIcon;
  /** Success toast; failures always toast. */
  toastMessage?: string;
}

/**
 * The one copy button. Every copy in the UI goes through it so clipboard
 * handling (Safari, insecure contexts, focus-trapped dialogs) and the
 * "Copied" feedback live in one place.
 */
export function CopyButton({
  text,
  label,
  icon: Icon = Copy,
  toastMessage,
  variant = "outline",
  size = "sm",
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number>();
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label ? undefined : "Copy"}
      {...props}
      onClick={async (e) => {
        // A copy never also activates the row or card it sits in.
        e.stopPropagation();
        if (!(await copyTextWithToast(text, toastMessage))) return;
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
      {label && <span className="ml-1.5">{copied ? "Copied" : label}</span>}
    </Button>
  );
}

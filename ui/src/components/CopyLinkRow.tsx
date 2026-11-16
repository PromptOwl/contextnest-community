/**
 * CopyLinkRow — the link to a document, one click to copy, shown at the top of
 * the share dialogs. The link is only an address: the server checks access when
 * it is opened, so it follows the nest's visibility and any per-document
 * sharing. Someone without access gets nothing from it.
 */
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";

export function CopyLinkRow({ url, hint }: { url: string; hint?: string }) {
  return (
    <div className="space-y-1.5" data-testid="share-copy-link">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Document link"
          className="min-w-0 flex-1 text-xs"
        />
        <CopyButton
          text={url}
          label="Copy link"
          variant="default"
          toastMessage="Link copied — it opens only for people with access"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {hint ?? "Anyone with the link still needs access. It opens for people who can already see this document."}
      </p>
    </div>
  );
}

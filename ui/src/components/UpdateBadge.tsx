/**
 * Footer badge for the server admin when a newer release is on npm. Opens the
 * command that updates this install; the server never updates itself.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reads } from "@/lib/queries";
import { DISMISSED_KEY, updateToAnnounce } from "@/lib/update-status";

const NPM_VERSIONS = "https://www.npmjs.com/package/@promptowl/contextnest-community?activeTab=versions";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function UpdateBadge() {
  const { data } = useQuery(reads.updateStatus());
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState(false);
  const version = updateToAnnounce(data, dismissed);
  if (!data || !version) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, version);
    } catch {
      /* private mode: it shows again next visit */
    }
    setDismissed(version);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
      >
        <ArrowUpCircle className="h-3 w-3" />v{version} available
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>ContextNest v{version} is available</DialogTitle>
            <DialogDescription>
              You're on v{data.current}.{" "}
              <a href={NPM_VERSIONS} target="_blank" rel="noreferrer" className="underline">
                See releases
              </a>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              {data.install === "container"
                ? "This server runs in a container. Pull the new image and recreate the container (Compose: docker compose pull && docker compose up -d; Helm: set image.tag and upgrade):"
                : "Stop the server, then start it again with the new version:"}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">{data.command}</code>
              <CopyButton text={data.command} toastMessage="Command copied" />
            </div>
            <p className="text-muted-foreground">Nests, users and settings stay in your data directory and database across the update.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dismiss}>
              Dismiss until the next version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A view node (§1.12): the server-rendered layout page, sized like the artifact viewer. */
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as api from "../lib/api";

export interface ViewNodePageProps {
  nestId: string;
  nodeId: string;
  title: string;
  onBack: () => void;
}

// No `sandbox` attribute on purpose: the page must keep the app origin so the
// sandboxed frames it embeds load with the session cookie. It runs no script
// (server CSP `script-src 'none'`) and every byte of it is server-escaped.
export function ViewNodePage({ nestId, nodeId, title, onBack }: ViewNodePageProps) {
  return (
    <div className="flex min-h-full flex-col gap-2 p-2 sm:p-3" data-testid="view-page">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <h1 className="truncate text-base font-semibold">{title || nodeId}</h1>
      </div>
      <iframe
        src={api.viewPageUrl(nestId, nodeId, null)}
        title={title || nodeId}
        className="w-full flex-1 min-h-[70vh] rounded-lg border bg-white"
        data-testid="view-page-frame"
      />
    </div>
  );
}

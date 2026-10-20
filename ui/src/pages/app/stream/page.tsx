/**
 * StreamPage — /stream: the experimental cross-nest document stream. What
 * changed recently in every nest you can read, newest first, with comments
 * inline. Gated by /health experimental.doc_stream (see meta.ts).
 */
import { Rss } from "lucide-react";
import { useAppNav } from "../../../lib/app-nav";
import { PageTitle } from "@/components/ui/page-title";
import { DocStream } from "../../../components/DocStream";

export default function StreamPage() {
  const { openReview } = useAppNav();
  return (
    <div className="space-y-4">
      <PageTitle
        icon={Rss}
        title={
          <span className="flex items-center gap-2">
            Stream
            <span className="rounded-sm border px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Experimental
            </span>
          </span>
        }
        description="Every document version across the nests you can read, newest first. An experimental feature: it may change or disappear."
        className="mb-0"
      />
      <DocStream
        onOpen={(item, threadId) =>
          openReview(item.nestId, item.nestName, item.nodeId, threadId ? { thread: threadId } : undefined)
        }
      />
    </div>
  );
}

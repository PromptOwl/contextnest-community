/**
 * StreamPage — /stream: the experimental cross-nest document stream, as a
 * feed (po-1214). What people and agents changed in every nest you can read,
 * newest first; reply, review, open and copy a link in place. Gated by /health experimental.doc_stream (see meta.ts).
 */
import { Rss } from "lucide-react";
import { useAppNav } from "../../../lib/app-nav";
import { PageTitle } from "@/components/ui/page-title";
import { DocStream } from "../../../components/DocStream";

export default function StreamPage() {
  const { openReview } = useAppNav();
  return (
    <div className="space-y-3">
      <PageTitle
        icon={Rss}
        title={
          <span className="flex items-center gap-2">
            Stream
            <span
              className="rounded-sm border px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              title="An experimental feature: it may change or disappear."
            >
              Experimental
            </span>
          </span>
        }
        description="What people and agents changed across your nests, newest first."
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

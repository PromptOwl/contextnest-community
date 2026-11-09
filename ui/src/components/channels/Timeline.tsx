/**
 * The open channel's posts, latest activity first, with "Load more" for the
 * older ones. A post the reader arrived at by link but that sits further down
 * than what is loaded is shown first, labelled as such.
 */
import { useState } from "react";
import { Loader2, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChannelPost } from "../../lib/api";
import type { TimelineState } from "../../lib/channels";
import { PostItem, type PostItemProps } from "./PostItem";
import { EmptyState } from "./StateBlocks";

type Shared = Omit<
  PostItemProps,
  "post" | "open" | "highlight" | "replyDraft" | "onReplyDraft" | "onToggle" | "onReply" | "onSetResolved" | "onPromote" | "onCopyLink"
>;

export function Timeline({
  state,
  openThread,
  highlightThread,
  replyDrafts,
  onReplyDraft,
  onToggle,
  onReply,
  onSetResolved,
  onPromote,
  onCopyLink,
  onLoadMore,
  ...shared
}: Shared & {
  state: TimelineState;
  openThread: string | null;
  highlightThread: string | null;
  replyDrafts: Record<string, string>;
  onReplyDraft: (threadId: string, next: string) => void;
  onToggle: (threadId: string) => void;
  onReply: (post: ChannelPost, body: string) => Promise<void>;
  onSetResolved: (post: ChannelPost, resolved: boolean) => void;
  onPromote: (post: ChannelPost) => void;
  onCopyLink: (post: ChannelPost) => void;
  onLoadMore: () => Promise<void>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  // The linked thread's post, when it is older than the loaded pages.
  const linked =
    openThread && shared.thread.data?.post.id === openThread && !state.posts.some((p) => p.id === openThread)
      ? shared.thread.data.post
      : null;
  const posts = linked ? [linked, ...state.posts] : state.posts;

  if (posts.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title="No messages yet"
        hint={
          shared.channel.can_post
            ? "Write the first one above. Type @ to bring in a teammate or an agent."
            : "Nothing has been posted in this channel."
        }
      />
    );
  }

  const item = (post: ChannelPost) => (
    <PostItem
      key={post.id}
      {...shared}
      post={post}
      open={openThread === post.id}
      highlight={highlightThread === post.id}
      replyDraft={replyDrafts[post.id] ?? ""}
      onReplyDraft={(next) => onReplyDraft(post.id, next)}
      onToggle={() => onToggle(post.id)}
      onReply={(body) => onReply(post, body)}
      onSetResolved={(resolved) => onSetResolved(post, resolved)}
      onPromote={() => onPromote(post)}
      onCopyLink={() => onCopyLink(post)}
    />
  );

  return (
    <div>
      {linked && <p className="mb-1 text-xs text-muted-foreground">An earlier thread in this channel</p>}
      <ul className="divide-y divide-border/60" data-testid="channel-timeline">
        {posts.map(item)}
      </ul>
      {state.has_more && (
        <div className="mt-4 flex items-center justify-center gap-3 border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            data-testid="channel-load-more"
            onClick={() => {
              setLoadingMore(true);
              void onLoadMore().finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
          <span className="text-xs text-muted-foreground">
            Showing {state.posts.length} of {state.total} posts
          </span>
        </div>
      )}
    </div>
  );
}

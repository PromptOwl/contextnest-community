/**
 * Channels usability pass (PO-1189): what each part of the page renders, by
 * acceptance criterion. Static renders, like the rest of the UI component
 * tests; behaviour over time (refresh, URL, dialogs) is covered by the rules
 * in ui/src/lib/channels.test.ts and by the live walkthrough.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChannelPost, ChannelSummary } from "../../lib/api";
import type { TimelineState } from "../../lib/channels";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelList } from "./ChannelList";
import { PostRefusal } from "./Composer";
import { MessageView } from "./MessageView";
import { PostItem, type PostItemProps } from "./PostItem";
import { EmptyState, ErrorState } from "./StateBlocks";
import { Timeline } from "./Timeline";
import { Hash } from "lucide-react";

const channel = (name: string, over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: `nodes/channels/${name}`,
  name,
  title: `#${name}`,
  type: "channel",
  purpose: null,
  archived: false,
  post_count: 12,
  last_post_at: null,
  last_activity_at: null,
  unread: 0,
  can_post: true,
  post_refusal: null,
  ...over,
});

const post = (over: Partial<ChannelPost> = {}): ChannelPost => ({
  id: "t1",
  author: "walt@team.test",
  author_name: "Walt Writer",
  actor: { human: "Walt Writer", agent: null, label: "Walt Writer" },
  body: "hello",
  created_at: "2026-11-09 13:41:44.927",
  cards: [],
  mentions: [],
  status: "open",
  reply_count: 0,
  last_reply_at: null,
  last_activity_at: "2026-11-09 13:41:44.927",
  promoted: [],
  ...over,
});

const noop = () => undefined;
const itemProps = (over: Partial<PostItemProps> = {}): PostItemProps => ({
  post: post(),
  channel: channel("ops"),
  canManage: true,
  open: false,
  highlight: false,
  thread: { data: null, loading: false, error: null, retry: noop },
  people: [],
  agents: [],
  replyDraft: "",
  onReplyDraft: noop,
  onToggle: noop,
  onReply: async () => undefined,
  onSetResolved: noop,
  onPromote: noop,
  onCopyLink: noop,
  onOpenNode: noop,
  ...over,
});

describe("AC-UX-06 messages render as markdown, with markup still escaped", () => {
  const html = (body: string) => renderToStaticMarkup(<MessageView message={post({ body })} />);

  it("formats bold, lists, a code fence and a table", () => {
    const h = html("**Freeze** the branch\n\n1. one\n2. two\n\n```bash\nnpm test\n```\n\n| Step | Owner |\n|---|---|\n| Freeze | Walt |");
    expect(h).toContain("<strong>Freeze</strong>");
    expect(h).toContain("<ol>");
    expect(h).toContain("<pre><code");
    expect(h).toContain("<table>");
    expect(h).not.toContain("**Freeze**");
  });

  it("makes links clickable, opening in a new tab", () => {
    const h = html("Docs: https://example.com/release-guide and [the plan](https://example.com/plan)");
    expect(h).toContain('<a href="https://example.com/release-guide" target="_blank" rel="noopener noreferrer">');
    expect(h).toContain('<a href="https://example.com/plan" target="_blank" rel="noopener noreferrer">the plan</a>');
  });

  it("never turns typed markup into elements", () => {
    const h = html('<img src=x onerror="alert(1)"> <script>alert(2)</script> ok');
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script");
    expect(h).toContain("ok");
  });
});

describe("AC-UX-08 mentions, names and times", () => {
  it("styles a mention that reached someone as resolved, by display name, and one that matched nobody as unresolved", () => {
    const h = renderToStaticMarkup(
      <MessageView
        message={post({
          body: "@rita@team.test and @grok and @nosuch.",
          mentions: [
            { name: "rita@team.test", kind: "person", display_name: "Rita Reader" },
            { name: "grok", kind: "agent", wakeable: true },
            { name: "nosuch", kind: "nobody" },
          ],
        })}
      />,
    );
    expect(h).toContain('data-mention="person"');
    expect(h).toContain("@Rita Reader</span>");
    expect(h).not.toContain(">@rita@team.test<");
    expect(h).toContain('data-mention="agent"');
    expect(h).toMatch(/data-mention="nobody"[^>]*>@nosuch<\/span>\./);
    expect(h).toContain("line-through");
  });

  it("shows the display name, not the email, and a relative time with the full time on hover", () => {
    const h = renderToStaticMarkup(<MessageView message={post({ created_at: new Date(Date.now() - 2 * 60_000).toISOString() })} />);
    expect(h).toContain(">Walt Writer</span>");
    expect(h).not.toContain(">walt@team.test<");
    expect(h).toMatch(/<time[^>]*title="[^"]+"[^>]*>2m ago<\/time>/);
  });

  it("names an agent and the person it acts for", () => {
    const h = renderToStaticMarkup(
      <MessageView message={post({ actor: { human: "Walt Writer", agent: "grok", label: "grok, on behalf of Walt Writer" } })} />,
    );
    expect(h).toContain(">grok</span>");
    expect(h).toContain("agent, on behalf of Walt Writer");
  });
});

describe("AC-UX-05 the number beside a channel is unread, never a total", () => {
  const html = renderToStaticMarkup(
    <ChannelList
      channels={[channel("general", { unread: 3, post_count: 40 }), channel("ops", { unread: 0, post_count: 58 })]}
      archived={[]}
      selected="ops"
      canManage={false}
      onSelect={noop}
      onNew={noop}
      onRestore={noop}
    />,
  );

  it("shows 3 for three unread and nothing for a read channel with 58 posts", () => {
    expect(html).toMatch(/aria-label="3 unread"[^>]*>3<\/span>/);
    expect(html).not.toContain("58");
    expect(html).not.toContain("40");
    expect(html.match(/data-testid="channel-unread"/g)).toHaveLength(1);
  });

  it("marks the open channel", () => {
    expect(html).toMatch(/aria-current="page"[^>]*>.*ops/s);
  });
});

describe("AC-UX-10 a reader who can't post is told why, in the composer's place", () => {
  it("shows the server's one line", () => {
    const h = renderToStaticMarkup(<PostRefusal channel={{ post_refusal: "This channel is archived. Restore it to post." }} />);
    expect(h).toContain("This channel is archived. Restore it to post.");
  });

  it("puts the same line where the reply box would be", () => {
    const h = renderToStaticMarkup(
      <PostItem {...itemProps({ open: true, channel: channel("ops", { can_post: false, archived: true, post_refusal: "This channel is archived." }) })} />,
    );
    expect(h).toContain("This channel is archived.");
    expect(h).not.toContain("<textarea");
    // Nothing to resolve or promote in a channel that takes no writes.
    expect(h).not.toContain("Resolve");
    expect(h).not.toContain("Promote");
  });
});

describe("AC-UX-11 a promoted post links to its node", () => {
  it("shows a Promoted link for each node the thread became", () => {
    const h = renderToStaticMarkup(
      <PostItem {...itemProps({ post: post({ promoted: [{ kind: "decision", node_id: "nodes/decisions/ship-on-friday", title: "Ship on Friday" }] }) })} />,
    );
    expect(h).toContain('data-testid="post-promoted"');
    expect(h).toContain("Promoted to decision: Ship on Friday");
  });

  it("offers Promote to people who manage channels only", () => {
    expect(renderToStaticMarkup(<PostItem {...itemProps()} />)).toContain("Promote");
    expect(renderToStaticMarkup(<PostItem {...itemProps({ canManage: false })} />)).not.toContain("Promote");
  });
});

describe("AC-UX-13 archived channels have their own section with Restore", () => {
  const list = (canManage: boolean, selected = "general") =>
    renderToStaticMarkup(
      <ChannelList
        channels={[channel("general")]}
        archived={[channel("retired", { archived: true })]}
        selected={selected}
        canManage={canManage}
        onSelect={noop}
        onNew={noop}
        onRestore={noop}
      />,
    );

  it("lists them under Archived, closed until asked for", () => {
    const h = list(true);
    expect(h).toContain("Archived (1)");
    expect(h).not.toContain("Restore");
  });

  it("opens the section for the archived channel on screen, with Restore for people who manage channels", () => {
    expect(list(true, "retired")).toContain('aria-label="Restore #retired"');
    expect(list(false, "retired")).not.toContain("Restore");
  });

  it("offers Restore in an archived channel's header, and archive only in a live one", () => {
    const archived = renderToStaticMarkup(
      <ChannelHeader channel={channel("retired", { archived: true })} canManage onArchive={noop} onRestore={noop} />,
    );
    expect(archived).toContain("Archived");
    expect(archived).toContain("Restore");
    const reader = renderToStaticMarkup(<ChannelHeader channel={channel("general")} canManage={false} onArchive={noop} onRestore={noop} />);
    expect(reader).not.toContain("channel-actions");
  });
});

describe("AC-UX-15 a failed read is an error with Retry, never the empty state", () => {
  it("shows the failure, the server's message and Retry", () => {
    const h = renderToStaticMarkup(<ErrorState title="Couldn't load channels" detail="Request failed: 500" onRetry={noop} />);
    expect(h).toContain('role="alert"');
    expect(h).toContain("Couldn&#x27;t load channels");
    expect(h).toContain("Request failed: 500");
    expect(h).toContain("Retry");
    expect(h).not.toContain("No channels yet");
  });

  it("an empty state says what to do next", () => {
    const h = renderToStaticMarkup(<EmptyState icon={Hash} title="No channels yet" hint="Create the first one to give your team a place to talk." />);
    expect(h).toContain("No channels yet");
    expect(h).toContain("Create the first one");
    expect(h).not.toContain('role="alert"');
  });

  it("a resolved thread shows a Resolved marker and offers Reopen", () => {
    const h = renderToStaticMarkup(<PostItem {...itemProps({ post: post({ status: "resolved" }) })} />);
    expect(h).toContain('data-testid="post-resolved"');
    expect(h).toContain("Reopen");
    expect(renderToStaticMarkup(<PostItem {...itemProps()} />)).not.toContain('data-testid="post-resolved"');
  });
});

describe("AC-UX-17 older posts load with Load more", () => {
  const state = (over: Partial<TimelineState> = {}): TimelineState => ({
    channel: channel("ops"),
    posts: [post({ id: "t2" }), post({ id: "t1" })],
    total: 58,
    has_more: true,
    next_since: "m-9",
    ...over,
  });
  const html = (s: TimelineState) => {
    const { post: _p, open: _o, highlight: _h, replyDraft: _r, onReplyDraft: _d, onToggle: _t, onReply: _y, onSetResolved: _s, onPromote: _m, onCopyLink: _c, ...shared } = itemProps();
    return renderToStaticMarkup(
      <Timeline
        {...shared}
        state={s}
        openThread={null}
        highlightThread={null}
        replyDrafts={{}}
        onReplyDraft={noop}
        onToggle={noop}
        onReply={async () => undefined}
        onSetResolved={noop}
        onPromote={noop}
        onCopyLink={noop}
        onLoadMore={async () => undefined}
      />,
    );
  };

  it("says how many are shown and offers the rest", () => {
    const h = html(state());
    expect(h).toContain("Load more");
    expect(h).toContain("Showing 2 of 58 posts");
  });

  it("has no button once everything is loaded", () => {
    expect(html(state({ has_more: false, total: 2 }))).not.toContain("Load more");
  });

  it("an empty channel says what to do next", () => {
    const h = html(state({ posts: [], has_more: false, total: 0 }));
    expect(h).toContain("No messages yet");
    expect(h).toContain("Write the first one above");
  });
});

describe("AC-UX-18 phone: per-post actions fold into one menu", () => {
  it("keeps Reply a button and hides the inline actions below the sm breakpoint", () => {
    const h = renderToStaticMarkup(<PostItem {...itemProps({ post: post({ reply_count: 2 }) })} />);
    expect(h).toContain("2 replies");
    expect(h).toMatch(/class="hidden items-center gap-1 sm:flex[ "]/);
    expect(h).toMatch(/title="Message actions"/);
    expect(h).toMatch(/sm:hidden/);
  });

  it("every action is at least 32px tall", () => {
    const h = renderToStaticMarkup(<PostItem {...itemProps()} />);
    const buttons = h.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(2);
    for (const b of buttons) expect(b).toMatch(/\bh-8\b/);
  });
});

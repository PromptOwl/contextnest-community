/** My Work mention rows (PO-1189). */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MentionItem } from "../../lib/api";
import { MentionRows, mentionAuthor } from "./MentionRows";

const mention = (over: Partial<MentionItem> = {}): MentionItem => ({
  type: "mention",
  kind: "channel",
  nest_id: "n1",
  nest_name: "Team",
  node_id: "nodes/channels/ops",
  title: "#ops",
  channel: "ops",
  thread_id: "t1",
  comment_id: "c1",
  excerpt: "@rita can you check the deploy?",
  author: "walt@team.test",
  author_name: "Walt Writer",
  author_label: "Walt Writer",
  agent: null,
  for_agent: null,
  mentioned_at: "2026-11-09 13:41:44.927",
  ...over,
});

const noop = () => undefined;
const render = (mentions: MentionItem[], busyThread: string | null = null) =>
  renderToStaticMarkup(
    <MentionRows mentions={mentions} loading={false} busyThread={busyThread} onOpen={noop} onDone={noop} onPage={noop} />,
  );

describe("AC-UX-09 Mark done on a mention row", () => {
  it("offers Mark done on channel and document mentions alike", () => {
    const h = render([mention(), mention({ kind: "document", channel: null, title: "Launch Plan", thread_id: "t2" })]);
    expect(h.match(/data-testid="my-work-mention-done"/g)).toHaveLength(2);
    expect(h.match(/Mark done/g)).toHaveLength(2);
    expect(h).toContain("in #ops");
    expect(h).toContain("in Launch Plan");
  });

  it("disables the row's button while its write is in flight", () => {
    expect(render([mention()], "t1")).toMatch(/<button[^>]*disabled=""[^>]*data-testid="my-work-mention-done"|data-testid="my-work-mention-done"[^>]*disabled=""/);
  });

  it("renders nothing when there are no mentions", () => {
    expect(render([])).toBe("");
  });
});

describe("AC-UX-08 My Work shows display names, not emails", () => {
  it("uses the display name the server sends", () => {
    expect(render([mention()])).toContain(">Walt Writer</span>");
    expect(mentionAuthor(mention({ agent: "grok", author_label: "grok, on behalf of Walt Writer" }))).toBe("grok, on behalf of Walt Writer");
  });

  it("falls back to the display name when the label still carries an email", () => {
    expect(mentionAuthor(mention({ author_label: "walt@team.test" }))).toBe("Walt Writer");
    expect(mentionAuthor(mention({ agent: "grok", author_label: "grok, on behalf of walt@team.test" }))).toBe("grok, on behalf of Walt Writer");
  });
});

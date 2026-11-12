/**
 * The stream post's actions (po-1214, AC-ST-02 and AC-ST-05). Static render,
 * like the other component tests here (no DOM in vitest): which actions a
 * post offers, for whom. The endpoints the actions call are covered by the
 * server suites (test/doc-stream-feed.test.ts, the review tests).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamPost } from "./DocStream";

const noop = () => {};
const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "n:a@2", nestId: "n", nestName: "Revenue", nodeId: "nodes/a", title: "Renewal checklist", type: "document",
    tags: [], version: 2, status: "published", author: "dana@acme.com", authorName: "Dana Okafor", client: null,
    changeNote: null, review: null, at: "2026-11-01 09:00:00", summary: "Confirm the decision maker.",
    commentCount: 2, kind: "published", ...over,
  }) as any;
const render = (over: Record<string, unknown> = {}, showNest = true) =>
  renderToStaticMarkup(
    <StreamPost item={item(over)} showNest={showNest} expanded={false} onToggleReplies={noop} onOpen={noop} onCommented={noop} onReviewed={noop} />,
  );

describe("stream post actions (po-1214)", () => {
  it("AC-ST-05: Given any post, Then reply, open and copy link are on it", () => {
    const html = render();
    for (const id of ["stream-reply", "stream-open", "stream-copy-link"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).not.toContain('data-testid="stream-approve"');
  });

  it("AC-ST-05: Given an in-review post and a reader who may review, Then Approve and Request changes show", () => {
    const html = render({ status: "pending_review", review: { canReview: true } });
    expect(html).toContain('data-testid="stream-approve"');
    expect(html).toContain('data-testid="stream-request-changes"');
    expect(html).toContain("in review");
  });

  it("AC-ST-05: Given an in-review post and a reader who may not review, Then no review action shows", () => {
    const html = render({ status: "pending_review", review: { canReview: false } });
    expect(html).not.toContain('data-testid="stream-approve"');
    expect(html).not.toContain('data-testid="stream-request-changes"');
  });

  it("AC-ST-09: Given a public reader's post, Then there is no reply action and no name", () => {
    const html = render({ author: null, authorName: null, commentCount: null });
    expect(html).not.toContain('data-testid="stream-reply"');
    expect(html).toContain("Someone");
  });

  it("AC-ST-02: Given an agent post, Then it names the person, then the agent, and wears the agent mark", () => {
    const html = render({ client: { agent: "mkt-amplifier" } });
    expect(html).toContain("Dana Okafor");
    expect(html).toContain("via mkt-amplifier");
    expect(html).toContain('data-testid="stream-post-agent-mark"');
    expect(html.indexOf("Dana Okafor")).toBeLessThan(html.indexOf("via mkt-amplifier"));
    expect(html).not.toContain(">dana@acme.com<");
  });

  it("AC-ST-03: Given an edit with a change note, Then the content line says what happened and why", () => {
    const html = render({ kind: "updated", status: "draft", changeNote: "Log the call the same day" });
    expect(html).toContain("edited");
    expect(html).toContain("Log the call the same day");
  });
});

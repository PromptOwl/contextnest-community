/** A Slack listener's row: where it listens and where to change it, never the generic settings. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedBySlack } from "./MetacognitionPanel";

const base = { kind: "slack" as const, channel: "product", status: "active", folders: ["decisions/", "/"] };
const html = (over: Partial<typeof base> | { channel: null } = {}, canOpenSetup = true) =>
  renderToStaticMarkup(<ManagedBySlack managed={{ ...base, ...over }} canOpenSetup={canOpenSetup} />);

describe("ManagedBySlack", () => {
  it("names the channel and folders and links to Setup for a server admin", () => {
    const h = html();
    expect(h).toContain("Listens in #product");
    expect(h).toContain("decisions/, the top level");
    expect(h).toContain('href="/control-room?section=setup"');
    expect(h).toContain('href="/control-room?section=agents"');
  });
  it("gives a nest admin who can't open the Control room words, not a dead link", () => {
    expect(html({}, false)).not.toContain("href");
    expect(html({}, false)).toContain("A server admin can change it");
  });
  it("says when it is paused, has no folders, or has no channel name", () => {
    expect(html({ status: "paused_guard" })).toContain("Paused in #product");
    expect(html({ folders: [] })).toContain("proposes nothing");
    expect(html({ channel: null })).toContain("a Slack conversation");
  });
});

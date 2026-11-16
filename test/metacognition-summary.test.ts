/**
 * The plain-language summary of a metacognition agent's config (CU-wdqcq05rqq):
 * what an MCP harness shows the person before it saves one. Pure function over
 * a parsed config, so these run without a server.
 */
import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/metacognition/config.js";
import { summarizeConfig } from "../src/metacognition/summary.js";

const base = {
  persona: { name: "Archivist", avatar: "🦉" },
  scope: { read: ["gtm", "ops"], propose: ["gtm"] },
};

describe("summarizeConfig", () => {
  it("names what it reads, where it may suggest edits and the proposal cap", () => {
    const s = summarizeConfig(parseConfig(base));
    expect(s.startsWith("Archivist will read gtm and ops, may suggest edits in gtm, up to 5 per run")).toBe(true);
  });

  it("an empty read scope is the whole nest", () => {
    const s = summarizeConfig(parseConfig({ ...base, scope: { read: [], propose: [] } }));
    expect(s).toContain("will read the whole nest");
  });

  it('propose [] means no edits, only comments', () => {
    const s = summarizeConfig(parseConfig({ ...base, scope: { read: ["gtm"], propose: [] } }));
    expect(s).toContain("won't suggest edits");
    expect(s).toContain("only comment");
    expect(s).not.toContain("may suggest edits");
  });

  it('propose ["*"] means anywhere it reads', () => {
    const s = summarizeConfig(parseConfig({ ...base, scope: { read: ["gtm", "ops"], propose: ["*"] } }));
    expect(s).toContain("may suggest edits anywhere it reads");
    const whole = summarizeConfig(parseConfig({ ...base, scope: { read: [], propose: ["*"] } }));
    expect(whole).toContain("may suggest edits anywhere in the nest");
  });

  it("a proposal cap of 0 is comments only, whatever propose says", () => {
    const s = summarizeConfig(parseConfig({ ...base, caps: { max_proposals: 0 } }));
    expect(s).toContain("won't suggest edits");
  });

  it("says the caps in words", () => {
    const s = summarizeConfig(parseConfig(base));
    expect(s).toContain("up to 5 comments per run");
    expect(s).toContain("12 steps");
    expect(s).toContain("300,000 tokens");
    expect(s).toContain("5 minutes");
    expect(summarizeConfig(parseConfig({ ...base, caps: { max_seconds: 90 } }))).toContain("90 seconds");
    expect(summarizeConfig(parseConfig({ ...base, caps: { max_seconds: 60 } }))).toContain("1 minute,");
    expect(summarizeConfig(parseConfig({ ...base, caps: { max_comments: 0 } }))).toContain("won't comment");
  });

  it("lists three folders as a, b and c", () => {
    const s = summarizeConfig(parseConfig({ ...base, scope: { read: ["a", "b", "c"], propose: [] } }));
    expect(s).toContain("will read a, b and c");
  });

  it("names its feeds and the MCP tools it may call", () => {
    const s = summarizeConfig(
      parseConfig({
        ...base,
        feeds: [{ name: "news", url: "https://feeds.example.com/news.xml" }],
        mcp_servers: [{ name: "desk", url: "https://mcp.example.com/mcp", allowed_tools: ["search", "get"] }],
      }),
    );
    expect(s).toContain("news");
    expect(s).toContain("desk");
    expect(s).toContain("search and get");
  });

  it("always ends: it never publishes; every change goes to a reviewer", () => {
    for (const scope of [
      { read: [], propose: [] },
      { read: ["gtm"], propose: ["*"] },
      { read: ["gtm"], propose: ["gtm"] },
    ]) {
      expect(summarizeConfig(parseConfig({ ...base, scope }))).toMatch(
        /It never publishes; every change goes to a reviewer\.$/,
      );
    }
  });

  it("says when it is switched off", () => {
    expect(summarizeConfig(parseConfig(base), { enabled: false })).toContain("switched off");
    expect(summarizeConfig(parseConfig(base), { enabled: true })).not.toContain("switched off");
  });
});

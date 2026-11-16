/**
 * Welcome-screen logic (PO-1185): AC3 (every tile has the nest's MCP URL),
 * AC4 (the tile reports the connect proof), AC7 (unconfirmed harnesses say so
 * and fall back to the general MCP steps), plus distill progress and the
 * Slack tile (AC9, AC10).
 */
import { describe, it, expect } from "vitest";
import {
  harnessTiles,
  connectionLabel,
  distillProgress,
  slackTile,
  slackReturn,
  generalInstructionsUrl,
  type TileContext,
} from "./onboarding";

const nest = {
  id: "n-1",
  name: "Dana's nest",
  mcp_url: "https://nest.example.com/nests/n-1/mcp",
  server_mcp_url: "https://nest.example.com/mcp",
};
const ctx = (over: Partial<TileContext> = {}): TileContext => ({
  nest,
  serverUrl: "https://nest.example.com",
  openMode: false,
  mcpOauthEnabled: true,
  hootieEnabled: true,
  ...over,
});

describe("AC3: one tile per named harness, each with the nest's MCP URL", () => {
  it("Given a nest, When the user opens Connect your agents, Then there is a tile for each harness, Hootie and Claude first", () => {
    const tiles = harnessTiles(ctx());
    expect(tiles.map((t) => t.id)).toEqual(["hootie", "claude", "duet", "muse", "grok", "hermes", "instinct", "goose"]);
    for (const t of tiles) {
      expect(t.connectUrl === nest.mcp_url || t.connectUrl === nest.server_mcp_url).toBe(true);
      // Every tile shows this nest's own MCP URL somewhere in its body or as its URL.
      expect(t.steps.includes(nest.mcp_url) || t.connectUrl === nest.mcp_url || t.steps.includes(nest.server_mcp_url)).toBe(true);
    }
  });

  it("never carries key material, only the placeholder", () => {
    for (const t of harnessTiles(ctx({ mcpOauthEnabled: false }))) {
      expect(t.steps).not.toMatch(/cnst_[A-Za-z0-9]/);
    }
  });

  it("Claude uses sign-in on the server URL when OAuth is on, the nest URL with a header when it is off", () => {
    const on = harnessTiles(ctx()).find((t) => t.id === "claude")!;
    expect(on.auth).toBe("oauth");
    expect(on.steps).toContain("Add custom connector");
    expect(on.steps).toContain(nest.server_mcp_url);
    const off = harnessTiles(ctx({ mcpOauthEnabled: false })).find((t) => t.id === "claude")!;
    expect(off.auth).toBe("key");
    expect(off.steps).toContain(nest.mcp_url);
  });

  it("Hermes and Grok reuse the repo's harness list, pointed at this nest", () => {
    const tiles = harnessTiles(ctx());
    expect(tiles.find((t) => t.id === "hermes")!.steps).toContain(`url: "${nest.mcp_url}"`);
    expect(tiles.find((t) => t.id === "grok")!.steps).toContain(nest.mcp_url);
    expect(tiles.find((t) => t.id === "hermes")!.source).toMatch(/hermes-agent\.nousresearch\.com/);
  });
});

describe("AC7: unconfirmed harnesses do not invent steps", () => {
  it("Given a harness whose connect steps are not confirmed, Then the tile says so and gives the general MCP steps", () => {
    const tiles = harnessTiles(ctx());
    for (const id of ["duet", "muse", "instinct"]) {
      const t = tiles.find((x) => x.id === id)!;
      expect(t.confirmed).toBe(false);
      expect(t.source).toBeUndefined();
      expect(t.steps).toMatch(/could not confirm .* exact connect steps/);
      expect(t.steps).toContain(nest.mcp_url);
      // No product menu path is claimed for it.
      expect(t.steps).not.toMatch(/Settings →/);
    }
    expect(generalInstructionsUrl("https://nest.example.com/")).toBe("https://nest.example.com/llms.txt");
  });

  it("Goose is confirmed only where its documented sign-in path exists", () => {
    expect(harnessTiles(ctx()).find((t) => t.id === "goose")!.confirmed).toBe(true);
    const off = harnessTiles(ctx({ mcpOauthEnabled: false })).find((t) => t.id === "goose")!;
    expect(off.confirmed).toBe(false);
    expect(off.steps).toMatch(/could not confirm/);
  });

  it("in open mode no tile asks for a credential", () => {
    for (const t of harnessTiles(ctx({ openMode: true, mcpOauthEnabled: false }))) {
      expect(t.steps).not.toMatch(/Bearer <your ContextNest API key>|your API key/);
    }
  });
});

describe("AC4: the tile reports the server's connect proof", () => {
  const claude = harnessTiles(ctx()).find((t) => t.id === "claude")!;
  it("waits until the server saw a read", () => {
    expect(connectionLabel({ connected: false, at: null, via: null, client: null, tool: null }, claude).state).toBe("waiting");
  });
  it("Given a harness tile, When the agent reads the nest, Then the tile shows that the agent is connected", () => {
    const l = connectionLabel({ connected: true, at: "t", via: "mcp", client: "claude-ai", tool: "context_list" }, claude);
    expect(l).toEqual({ state: "connected", text: "Claude read your nest" });
  });
  it("names a different client honestly instead of claiming it was this one", () => {
    const l = connectionLabel({ connected: true, at: "t", via: "mcp", client: "goose", tool: "context_list" }, claude);
    expect(l.state).toBe("other");
    expect(l.text).toContain('"goose"');
  });
});

describe("distill progress (AC8)", () => {
  it("runs from a small start to 100 on done", () => {
    expect(distillProgress({ status: "running", phase: "fetching", done_steps: 0, total_steps: 0, nodes: [], error: null }).percent).toBe(2);
    const mid = distillProgress({ status: "running", phase: "extracting", done_steps: 2, total_steps: 5, nodes: [], error: null });
    expect(mid.percent).toBe(40);
    expect(mid.label).toBe("Extracting (2 of 4 parts)");
    expect(distillProgress({ status: "done", phase: "done", done_steps: 9, total_steps: 9, nodes: [1, 2], error: null })).toEqual({ percent: 100, label: "Done. 2 drafts are waiting for your review." });
    expect(distillProgress({ status: "done", phase: "done", done_steps: 9, total_steps: 9, nodes: [1], error: null }).label).toBe("Done. 1 draft is waiting for your review.");
    expect(distillProgress({ status: "failed", phase: "failed", done_steps: 1, total_steps: 9, nodes: [], error: "No." }).label).toBe("No.");
  });
});

describe("Slack tile (AC9, AC10)", () => {
  const base = { configured: true, can_connect: true, connected: false, admin_settings_path: null, reason: null, disclosure: "d" };
  it("connects when configured, shows connected on return", () => {
    expect(slackTile(base, true).action).toBe("connect");
    expect(slackTile({ ...base, connected: true }, true).action).toBe("connected");
    expect(slackReturn("?onboarding=slack&slack=connected&x=1")).toEqual({ returned: true, connected: true, clean: "?x=1" });
  });
  it("Given Slack is not configured, Then the tile says a server admin must configure it; an admin gets the setting", () => {
    const user = slackTile({ ...base, configured: false, can_connect: false, reason: "A server admin must configure the Slack app on this server first." }, true);
    expect(user.action).toBe("blocked");
    expect(user.text).toMatch(/server admin must configure/);
    expect(slackTile({ ...base, configured: false, can_connect: false, admin_settings_path: "/settings" }, true).action).toBe("admin");
  });
});

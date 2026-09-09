import { describe, it, expect } from "vitest";
import {
  nestSummary,
  serverMcpUrl,
  allNestsChatPrompt,
  nestChatPrompt,
  nestSetupPrompt,
  envFileContents,
  ctxCliConnectSnippet,
} from "./connect";

// Regression tests written before the implementation (dev-loop: fail-before-build).
// These pin the pure logic behind the "All my nests" landing + Connect-all UX,
// which is the only part testable in this repo's node-only vitest setup.

describe("nestSummary", () => {
  it("counts nests and sums document_count across mixed value types", () => {
    expect(
      nestSummary([
        { document_count: 5 },
        { document_count: "3" }, // server sometimes serializes counts as strings
        { document_count: null },
        {}, // missing entirely
      ]),
    ).toEqual({ nestCount: 4, documentCount: 8 });
  });

  it("is all-zero for an empty brain", () => {
    expect(nestSummary([])).toEqual({ nestCount: 0, documentCount: 0 });
  });

  it("never returns NaN when a count is garbage", () => {
    expect(nestSummary([{ document_count: "oops" as unknown as number }])).toEqual({
      nestCount: 1,
      documentCount: 0,
    });
  });
});

describe("serverMcpUrl", () => {
  it("appends /mcp to the server base", () => {
    expect(serverMcpUrl("https://community.promptowl.ai")).toBe(
      "https://community.promptowl.ai/mcp",
    );
  });

  it("tolerates one or more trailing slashes", () => {
    expect(serverMcpUrl("https://x.ai/")).toBe("https://x.ai/mcp");
    expect(serverMcpUrl("https://x.ai///")).toBe("https://x.ai/mcp");
  });
});

describe("allNestsChatPrompt", () => {
  it("points the agent at the server-level /mcp endpoint", () => {
    expect(allNestsChatPrompt("https://x.ai/")).toContain("https://x.ai/mcp");
  });

  it("tells the agent to call nest_index first", () => {
    expect(allNestsChatPrompt("https://x.ai")).toContain("nest_index");
  });

  it("never embeds an API key or secret in the prompt", () => {
    // The whole point of the redesign: keys are the user's to hand over, never baked in.
    expect(allNestsChatPrompt("https://x.ai")).not.toMatch(/cnst_|api[_-]?key\s*[:=]/i);
  });
});

describe("nestChatPrompt", () => {
  it("names the nest and forbids inventing answers", () => {
    const p = nestChatPrompt("GTM Strategy", "Go-to-market strategy");
    expect(p).toContain('"GTM Strategy"');
    expect(p).toMatch(/don't invent/i);
  });

  it("works with no description and doesn't throw", () => {
    expect(() => nestChatPrompt("Solo")).not.toThrow();
    expect(nestChatPrompt("Solo")).toContain('"Solo"');
  });

  it("embeds no secret", () => {
    expect(nestChatPrompt("X", "y")).not.toMatch(/cnst_/);
  });
});

describe("nestSetupPrompt", () => {
  it("gives an immediate REST read and the MCP url, both per-nest", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai/", "gtm");
    expect(p).toContain("https://x.ai/nests/gtm/context");
    expect(p).toContain("https://x.ai/nests/gtm/mcp");
  });

  it("has an anti-hallucination proof gate and a no-shell handoff", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/do NOT claim you'?re connected/i);
    expect(p).toMatch(/settings . connectors/i); // no-shell handoff path
  });

  // Was: "uses npx (not a global install) and asks for the key". Both halves
  // pinned the `push` line, which left this prompt with CU-wdqcq01kh8 (push is
  // a write-a-folder-up job, and it taught agents the CLI is the only writer).
  // The surviving intent — the key is LOCATED, not merely requested — is what
  // this now asserts; the npx-not-global rule travels with push to wherever
  // push is documented.
  it("locates the key rather than only asking for it", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("CONTEXTNEST_API_KEY");
    expect(p).toMatch(/ask me for it and stop/i);
  });

  it("never bakes in a key", () => {
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).not.toMatch(/cnst_/);
  });

  // The 10-run agent experiment (2026-09-09) found one thing that moved the
  // needle: telling the agent what to do when the FIRST read fails. The
  // variant with documented fallbacks connected 2/2 against a broken server;
  // the variant that said "if it fails, stop" connected 0/2. These pin that.
  it("says what to do when the first read is refused for a license", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("503");
    // /context is a POST and POSTs are license-gated; these GETs are not, so
    // they are the only reads that work on an unlicensed server.
    // /export is a GET (so the gate misses it) and returns every document WITH
    // its body in ONE call — the cheapest unlicensed read. List-then-read
    // survives as the escape hatch for a nest too large to take whole.
    expect(p).toContain("/nests/gtm/export?format=markdown");
    expect(p).toContain("/nests/gtm/nodes/nodes/<slug>");
  });

  it("distinguishes a missing key from a blocked network", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("401");
    // Egress-restricted environments (cloud sandboxes, CI, corporate proxies)
    // cannot reach the host at all — retrying never helps, so say so.
    expect(p).toMatch(/refused|blocked|cannot reach/i);
  });

  it("does not mistake an app-level 403 for a blocked network", () => {
    // The server itself 403s a key scoped to another nest — fixable, and
    // nothing to do with egress. Those carry a JSON error body; a gateway
    // block generally does not, so the prompt splits on that.
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/403[\s\S]*scoped to a different nest/);
  });

  it("names where the key is expected instead of only asking for it", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    // The old copy said "ask me for my API key" AND "never in our chat",
    // naming no other channel. Four of ten runs stopped there.
    expect(p).toContain("CONTEXTNEST_API_KEY");
  });

  it("does not promise self-setup of the key, which is impossible", () => {
    // /auth/keys needs a signed-in session, so an agent cannot mint its own.
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).not.toMatch(
      /set it up yourself/i,
    );
  });

  it("does not claim writes work on a server it just said is unlicensed", () => {
    // The gate is `method !== "GET"`, so a 503 on /context means every write is
    // blocked too. Both agents in testing spotted the contradiction and
    // correctly disbelieved the write claim — so the prompt now scopes it.
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/WRITES ARE ALSO UNAVAILABLE/);
    // Leads with the state, not the capability: an agent that reads the first
    // clause and stops has still read something true.
    expect(p).toMatch(/if step 1 returned 503 this server is unlicensed/);
    expect(p).toMatch(/do not attempt writes at all/);
  });

  it("says the MCP and ctx paths are blocked on an unlicensed server too", () => {
    // MCP is transported over POST, so `method !== "GET"` 503s it — verified
    // against a real unlicensed server (initialize returns a JSON-RPC
    // "License required"). `ctx vault add` targets the same MCP URL.
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/both go over MCP, which is POST/);
  });

  it("prints the status code its own branches dispatch on", () => {
    // Plain `curl -s` shows the body and nothing else, so a prompt that says
    // "the status code tells you which problem you have" and then lists
    // 503/401/403 was asking an agent to read a number never put on screen.
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).toContain("%{http_code}");
  });

  it("tells the agent to reuse the returned id rather than assume a prefix", () => {
    // `nodes/` is the structured layout's prefix. An imported nest has flat
    // ids, and assuming the prefix there reads a directory that does not
    // exist — the nest looks empty. Reusing the id verbatim is right for both.
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/EXACTLY as the list returned it/);
    expect(p).toMatch(/imported from a folder has no such prefix/);
  });

  it("puts the node id on the PATCH path, not just the collection", () => {
    // POST is the collection; PATCH is mounted on /:nodeId.
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).toMatch(
      /PATCH that same path with the document's\s*\n?\s*id appended/,
    );
  });

  it("names write tools rather than asserting write capability", () => {
    // Prose assertion ("this connection reads AND writes") left 5 of 6 agents
    // answering "unsure". A named mechanism is what they actually believed.
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("context_create");
    expect(p).toContain("context_update");
  });

  it("keeps push out of the setup brief", () => {
    // `push` uploads a local folder INTO the nest — a different job, and the
    // direct cause of agents concluding the CLI is the only writer.
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).not.toContain("push");
  });

  it("shows the citation format with a real id shape", () => {
    // Agents read a bare `nest:id` as a literal "nest:" prefix; real ids look
    // like nodes/returns-policy.
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).toContain("nodes/");
  });
});

describe("envFileContents", () => {
  it("includes server + key, and the nest line when a nestId is given", () => {
    const e = envFileContents({
      serverUrl: "https://x.ai/",
      apiKey: "cnst_abc",
      nestId: "n1",
    });
    expect(e).toContain("CONTEXTNEST_SERVER=https://x.ai");
    expect(e).toContain("CONTEXTNEST_API_KEY=cnst_abc");
    expect(e).toContain("CONTEXTNEST_NEST=n1");
  });

  it("omits the nest line when no nestId (all-nests key)", () => {
    const e = envFileContents({ serverUrl: "https://x.ai", apiKey: "cnst_abc" });
    expect(e).not.toContain("CONTEXTNEST_NEST");
  });

  it("warns not to commit the file", () => {
    expect(
      envFileContents({ serverUrl: "https://x.ai", apiKey: "k" }),
    ).toMatch(/do not commit/i);
  });
});

describe("open-mode prompts (AUTH_MODE=open)", () => {
  it("allNestsChatPrompt drops every credential instruction", () => {
    const p = allNestsChatPrompt("https://x.ai", true);
    expect(p).not.toMatch(/api key/i);
    expect(p).toContain("no credential");
    expect(p).toContain("https://x.ai/mcp");
  });

  it("nestSetupPrompt drops the Bearer header and the KEY section", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm", true);
    expect(p).not.toMatch(/authorization: bearer/i);
    expect(p).not.toMatch(/api key/i);
    // still fully usable: the proof gate and both connect paths survive
    expect(p).toContain("https://x.ai/nests/gtm/context");
    expect(p).toMatch(/settings . connectors/i);
  });

  it("key mode is unchanged (default arg)", () => {
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).toMatch(
      /Authorization: Bearer/,
    );
    expect(allNestsChatPrompt("https://x.ai")).toMatch(/api key/i);
  });
});

describe("write honesty (ticket AC: no false read-only claims)", () => {
  it("does not claim the server-level connection is read-only", () => {
    const p = allNestsChatPrompt("https://x.ai");
    expect(p).not.toMatch(/does ?n'?t write|read-only/i);
    // server-routes.ts exposes nest_create + context_create on /mcp
    expect(p).toContain("nest_create");
    expect(p).toContain("context_create");
    expect(p).toMatch(/asking me first/i);
  });
});

describe("ctx CLI contract (CLI 2.2+: env-based key, remote vault alias)", () => {
  // The CLI README says: never put the key on argv — `ctx` reads
  // CONTEXTNEST_API_KEY. The old prompt told agents to run `push … --key <key>`
  // (a comment claimed ctx read no env var, verified against 1.2.1 — stale).
  it("passes the key through CONTEXTNEST_API_KEY, never as a --key flag", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("CONTEXTNEST_API_KEY");
    expect(p).not.toContain("--key <key>");
    expect(p).not.toMatch(/--key\b/);
  });

  it("omits both the env var and the key flag in open mode", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm", true);
    expect(p).not.toContain("CONTEXTNEST_API_KEY");
    expect(p).not.toContain("--key");
  });

  it("tells a shell agent to register the nest as a ctx vault alias", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("ctx vault add");
    expect(p).toContain("--url https://x.ai/nests/gtm/mcp");
    expect(p).toContain("--bearer-env CONTEXTNEST_API_KEY");
    expect(p).toMatch(/--vault \S+/);
  });

  it("allNestsChatPrompt is unchanged by the CLI work (regression)", () => {
    const p = allNestsChatPrompt("https://x.ai");
    expect(p).not.toContain("ctx vault add");
    expect(p).not.toContain("CONTEXTNEST_API_KEY");
    expect(p).toContain("https://x.ai/mcp");
  });
});

describe("ctxCliConnectSnippet", () => {
  it("emits the vault add line with a bearer env in key mode, plus a query example", () => {
    const s = ctxCliConnectSnippet("https://x.ai/", "gtm", "gtm");
    expect(s).toContain(
      "ctx vault add gtm --url https://x.ai/nests/gtm/mcp --bearer-env CONTEXTNEST_API_KEY",
    );
    expect(s).toMatch(/ctx query "#\S+" --vault gtm/);
  });

  it("drops --bearer-env entirely in open mode", () => {
    const s = ctxCliConnectSnippet("https://x.ai", "gtm", "gtm", true);
    expect(s).toContain("ctx vault add gtm --url https://x.ai/nests/gtm/mcp");
    expect(s).not.toContain("--bearer-env");
    expect(s).not.toContain("CONTEXTNEST_API_KEY");
  });

  it("never carries key material", () => {
    expect(ctxCliConnectSnippet("https://x.ai", "gtm", "gtm")).not.toMatch(/cnst_/);
    expect(ctxCliConnectSnippet("https://x.ai", "gtm", "gtm", true)).not.toMatch(/cnst_/);
  });

  it("sanitizes a free-form alias into something ctx accepts", () => {
    const s = ctxCliConnectSnippet("https://x.ai", "gtm", "GTM Strategy 2026!");
    expect(s).toContain("ctx vault add gtm-strategy-2026 --url");
    expect(s).toContain("--vault gtm-strategy-2026");
  });
});

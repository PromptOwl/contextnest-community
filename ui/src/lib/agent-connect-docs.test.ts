import { describe, it, expect } from "vitest";
import {
  HARNESSES,
  harnessById,
  renderHarnessDoc,
  renderAllHarnessDocs,
  type ConnectDocsContext,
} from "./agent-connect-docs";

const KEYED: ConnectDocsContext = { serverUrl: "https://nest.example.com" };
const OPEN: ConnectDocsContext = { serverUrl: "https://nest.example.com", openMode: true };

describe("harness registry", () => {
  it("has a unique id and a non-empty name for every harness", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HARNESSES) {
      expect(h.name.trim()).not.toBe("");
      expect(h.where.trim()).not.toBe("");
    }
  });

  it("covers the harnesses an admin is most likely to be asked about", () => {
    const ids = HARNESSES.map((h) => h.id);
    for (const expected of [
      "claude-code",
      "claude-desktop",
      "chatgpt",
      "codex",
      "grok",
      "hermes",
      "perplexity",
      "cursor",
      "gemini-cli",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("looks a harness up by id and returns undefined for an unknown one", () => {
    expect(harnessById("claude-code")?.name).toMatch(/Claude Code/i);
    expect(harnessById("nope")).toBeUndefined();
  });
});

describe("rendered instructions", () => {
  it("points every harness at the server-level /mcp endpoint", () => {
    for (const h of HARNESSES) {
      expect(renderHarnessDoc(h, KEYED)).toContain("https://nest.example.com/mcp");
    }
  });

  it("tolerates a trailing slash on the server URL without doubling it", () => {
    for (const h of HARNESSES) {
      const out = renderHarnessDoc(h, { serverUrl: "https://nest.example.com/" });
      expect(out).toContain("https://nest.example.com/mcp");
      expect(out).not.toContain("https://nest.example.com//mcp");
    }
  });

  /**
   * Same invariant the Connect surfaces hold (see connect.ts): these are
   * instructions, not a credential hand-off. Nothing here may render key
   * material — the admin's key is never in scope, so a `cnst_` literal in the
   * output could only be a hard-coded example that someone would paste.
   */
  it("never renders key material", () => {
    for (const h of HARNESSES) {
      for (const ctx of [KEYED, OPEN]) {
        expect(renderHarnessDoc(h, ctx)).not.toMatch(/cnst_[A-Za-z0-9]/);
      }
    }
  });

  it("drops every credential instruction in open mode", () => {
    for (const h of HARNESSES) {
      const out = renderHarnessDoc(h, OPEN);
      expect(out).not.toMatch(/Bearer/i);
      expect(out).not.toMatch(/CONTEXTNEST_API_KEY/);
    }
  });

  /**
   * The whole point of this panel is ONE connection that reads across every
   * nest the caller can see — public plus whatever private they have access
   * to. A per-nest URL (`/nests/<id>/mcp`) would quietly turn that back into
   * connect-once-per-nest, so no harness may ever render one.
   */
  it("never points a harness at a single nest", () => {
    for (const h of HARNESSES) {
      for (const ctx of [KEYED, OPEN]) {
        expect(renderHarnessDoc(h, ctx)).not.toMatch(/\/nests\//);
      }
    }
  });

  it("tells a keyed deployment how to present the key", () => {
    // Every harness that can take a static credential must name one concrete
    // mechanism; an admin reading the panel should never have to guess.
    for (const h of HARNESSES.filter((x) => x.support === "header")) {
      const out = renderHarnessDoc(h, KEYED);
      expect(out).toMatch(/Authorization|Bearer|CONTEXTNEST_API_KEY/);
    }
  });

  /**
   * Perplexity's custom-connector form drives an OAuth client, and Claude's
   * directory listing refuses bearer auth. Neither can work against a
   * deployment that only has API keys, so the panel must SAY that rather than
   * print steps that end in a failed connection.
   */
  it("warns, rather than instructs, where the surface needs OAuth we don't serve yet", () => {
    const oauthOnly = HARNESSES.filter((h) => h.support === "oauth-only");
    expect(oauthOnly.length).toBeGreaterThan(0);
    for (const h of oauthOnly) {
      expect(renderHarnessDoc(h, KEYED)).toMatch(/OAuth/i);
    }
  });
});

describe("the whole panel", () => {
  /**
   * A nest-scoped key sets `nestScope` on the request (src/auth/middleware.ts),
   * and buildNestIndex then filters the index down to that one nest — so the
   * same URL silently behaves as connect-once-per-nest. The panel has to say
   * which kind of key to use, or people will hit that and think it's a bug.
   */
  it("says a user-level key is required, not a nest-scoped one", () => {
    const doc = renderAllHarnessDocs(KEYED);
    expect(doc).toMatch(/user-level key/i);
    expect(doc).toMatch(/scoped to (a|one) (single )?nest|nest-scoped/i);
  });

  it("does not raise the key question at all in open mode", () => {
    expect(renderAllHarnessDocs(OPEN)).not.toMatch(/user-level key/i);
  });

  it("renders every harness under its own heading, in one document", () => {
    const doc = renderAllHarnessDocs(KEYED);
    for (const h of HARNESSES) {
      expect(doc).toContain(`## ${h.name}`);
    }
  });

  it("groups by kind so the chat surfaces aren't buried under the CLIs", () => {
    const doc = renderAllHarnessDocs(KEYED);
    expect(doc.indexOf("# Chat")).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf("# Command line")).toBeGreaterThan(doc.indexOf("# Chat"));
  });
});

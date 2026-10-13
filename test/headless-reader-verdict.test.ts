/**
 * The headless access-key allowlist as a pure function (CU-wdqcq0314u). Like
 * the nest-scoped key guard, the property that matters most is the default:
 * a route nobody thought about is closed to an access key.
 */
import { describe, it, expect } from "vitest";
import { headlessReaderVerdict, HEADLESS_READER_TOOLS } from "../src/auth/headless.js";

const N = "nest-a";
const ok = (m: string, p: string) => headlessReaderVerdict(m, p, N);

describe("headlessReaderVerdict", () => {
  it("allows the read surface of its own nest", () => {
    for (const [m, p] of [
      ["GET", `/nests/${N}`],
      ["GET", `/nests/${N}/nodes`],
      ["GET", `/nests/${N}/nodes/nodes/guide`],
      ["GET", `/nests/${N}/nodes/nodes/folder/deep-doc`],
      ["GET", `/nests/${N}/search`],
      ["POST", `/nests/${N}/context`],
      ["POST", `/nests/${N}/query`],
      ["POST", `/nests/${N}/table-query`],
      // The MCP transport itself, any method — every tool is gated per call.
      ["POST", `/nests/${N}/mcp`],
      ["GET", `/nests/${N}/mcp`],
      ["DELETE", `/nests/${N}/mcp`],
      ["POST", "/mcp"],
      ["GET", "/index"],
      ["GET", "/health"],
    ]) {
      expect(ok(m, p), `${m} ${p}`).toBe(true);
    }
  });

  it("refuses node sub-resources: history, comments, annotations, files", () => {
    for (const sub of ["versions", "versions/2", "comments", "annotations", "activity",
      "reviews", "stewards", "watchers", "hosted", "pdf", "can-edit", "external-edits"]) {
      expect(ok("GET", `/nests/${N}/nodes/nodes/guide/${sub}`), sub).toBe(false);
    }
  });

  it("refuses every write, export and governance route", () => {
    for (const [m, p] of [
      ["POST", `/nests/${N}/nodes`],
      ["PATCH", `/nests/${N}/nodes/nodes/guide`],
      ["DELETE", `/nests/${N}/nodes/nodes/guide`],
      ["GET", `/nests/${N}/export`],
      ["GET", `/nests/${N}/folders`],
      ["GET", `/nests/${N}/definitions`],
      ["GET", `/nests/${N}/census`],
      ["GET", `/nests/${N}/collaborators`],
      ["GET", `/nests/${N}/activity`],
      ["GET", `/nests/${N}/feed`],
      ["GET", `/nests/${N}/review-queue`],
      ["GET", `/nests/${N}/graph`],
      ["POST", `/nests/${N}/chat`],
      ["POST", `/nests/${N}/pin`],
      ["GET", `/nests/${N}/headless`],
      ["POST", `/nests/${N}/publish`],
    ]) {
      expect(ok(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it("refuses other nests, runs, stats, account and unknown routes", () => {
    for (const [m, p] of [
      ["GET", "/nests/nest-b"],
      ["GET", `/nests/${N}-evil/nodes`],
      ["GET", "/runs/r1"],
      ["GET", "/stats"],
      ["POST", "/auth/keys"],
      ["GET", "/me/work"],
      ["GET", "/some-future-route"],
    ]) {
      expect(ok(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it("names only read tools", () => {
    for (const t of HEADLESS_READER_TOOLS) {
      expect(t).not.toMatch(/create|update|delete|move|export|versions|comment|approve|reject|submit|grant|share|steward/);
    }
    for (const t of ["context_list", "context_get", "context_query", "context_search"]) {
      expect(HEADLESS_READER_TOOLS.has(t)).toBe(true);
    }
  });
});

// Node sub-resources are the one place the allowlist has to name what it
// refuses (a node id itself contains slashes, so "/nodes/<id>" can't be told
// apart structurally). This keeps that list complete: every GET sub-route
// registered under a node, now or later, must be refused to an access key
// unless it's added to ALLOWED_NODE_SUBROUTES here on purpose.
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ALLOWED_NODE_SUBROUTES: string[] = [];

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("node sub-route completeness", () => {
  it("every registered GET /nodes/:id/<sub> route is refused to an access key", () => {
    const subs = new Set<string>();
    // Routers that share the `/:nodeId{.+}/<sub>` shape but are mounted
    // somewhere other than /nests/:id/nodes — checked on their own below.
    const notNodeRouters = [join("src", "metacognition", "routes.ts")];
    for (const f of srcFiles("src")) {
      if (notNodeRouters.some((r) => f.endsWith(r))) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\.(?:get|head|all)\(\s*"\/:nodeId\{\.\+\}(\/[^"]+)"/g)) {
        subs.add(m[1].replace(/:version\{\[0-9\]\+\}/, "3").replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x"));
      }
    }
    expect(subs.size).toBeGreaterThan(5);
    const open = [...subs].filter(
      (s) => !ALLOWED_NODE_SUBROUTES.includes(s) && ok("GET", `/nests/${N}/nodes/nodes/guide${s}`),
    );
    expect(open).toEqual([]);
  });

  it("refuses the metacognition agent routes (config, run, stats) to an access key", () => {
    for (const [m, p] of [
      ["GET", `/nests/${N}/metacognition`],
      ["GET", `/nests/${N}/metacognition/nodes/agent`],
      ["GET", `/nests/${N}/metacognition/nodes/agent/stats`],
      ["POST", `/nests/${N}/metacognition/nodes/agent/run`],
    ]) {
      expect(ok(m, p), `${m} ${p}`).toBe(false);
    }
  });
});

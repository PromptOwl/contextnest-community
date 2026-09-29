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
      ["GET", `/nests/${N}/definitions`],
      ["GET", `/nests/${N}/folders`],
      ["POST", `/nests/${N}/context`],
      ["POST", `/nests/${N}/query`],
      ["POST", `/nests/${N}/table-query`],
      ["POST", `/nests/${N}/mcp`],
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

/**
 * The nest-scoped key allowlist as a pure function (CU-wdqcq02xqt). The
 * property that matters most is the default: a route nobody thought about is
 * closed to a nest key.
 */
import { describe, it, expect } from "vitest";
import { nestKeyVerdict } from "../src/auth/nest-scope-guard.js";

const A = "nest-a";
const ok = (m: string, p: string) => nestKeyVerdict(m, p, A).allowed;

describe("nestKeyVerdict", () => {
  it("allows its own nest, every sub-route and method", () => {
    expect(ok("GET", `/nests/${A}`)).toBe(true);
    expect(ok("DELETE", `/nests/${A}`)).toBe(true);
    expect(ok("POST", `/nests/${A}/nodes`)).toBe(true);
    expect(ok("POST", `/nests/${A}/mcp`)).toBe(true);
    expect(ok("GET", `/nests/${encodeURIComponent(A)}/nodes`)).toBe(true);
  });

  it("refuses another nest, flagging the MCP transport for a JSON-RPC reply", () => {
    expect(nestKeyVerdict("GET", "/nests/nest-b", A)).toEqual({
      allowed: false, reason: "other_nest", mcpTransport: false,
    });
    expect(nestKeyVerdict("POST", "/nests/nest-b/mcp", A)).toEqual({
      allowed: false, reason: "other_nest", mcpTransport: true,
    });
    expect(ok("GET", "/nests/unsynced")).toBe(false);
    // A nest id that merely starts with the scope is a different nest.
    expect(ok("GET", `/nests/${A}-evil/nodes`)).toBe(false);
  });

  it("allows the filtered cross-nest reads — GET only", () => {
    for (const p of ["/search", "/stats", "/nests", "/nests/", "/index"]) {
      expect(ok("GET", p)).toBe(true);
    }
    expect(ok("POST", "/nests")).toBe(false);
    expect(ok("POST", "/search")).toBe(false);
  });

  it("allows the agent MCP endpoint, runs, and public routes", () => {
    expect(ok("POST", "/mcp")).toBe(true);
    expect(ok("GET", "/runs/r1")).toBe(true);
    expect(ok("GET", "/health")).toBe(true);
    expect(ok("GET", "/llms.txt")).toBe(true);
  });

  it("refuses keys, account, admin, teams, people and inbox routes", () => {
    for (const [m, p] of [
      ["POST", "/auth/keys"], ["GET", "/auth/keys"], ["POST", "/auth/keys/rotate"],
      ["DELETE", "/auth/keys/k1"], ["PATCH", "/auth/profile"], ["POST", "/auth/password"],
      ["GET", "/auth/teammates"], ["POST", "/auth/invite"], ["DELETE", "/auth/users/u1"],
      ["GET", "/admin/settings"], ["GET", "/teams"], ["GET", "/people/suggest"],
      ["GET", "/me/work"], ["POST", "/license/install"],
    ]) {
      expect(ok(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it("is deny-by-default for a route it has never heard of", () => {
    expect(ok("GET", "/some-future-route")).toBe(false);
    expect(ok("POST", "/admin/brand-new")).toBe(false);
  });
});

/**
 * Surfaces S1 — connector contract (M10): AC-CON-01..03.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describeConnectorConformance } from "./surfaces-conformance.js";
import { createFakeConnector, conversation, member, FAKE_SECRET } from "./surfaces-fake-connector.js";
import { safeMembers } from "../src/surfaces/services/members.js";
import type { SurfaceInstallRef } from "../src/surfaces/contract.js";

const install: SurfaceInstallRef = {
  id: "inst-1",
  surface: "slack",
  tenant_key: "T1",
  team_id: "T1",
  enterprise_id: null,
  bot_user_id: "B_OURS",
};

describeConnectorConformance("fake (in-memory)", () => {
  const connector = createFakeConnector();
  connector.conversations.set("C1", { info: conversation("C1"), members: [member("U1"), member("U2")] });
  return {
    connector,
    install,
    goodRequest: () =>
      new Request("https://x/events", { method: "POST", headers: { "x-fake-signature": FAKE_SECRET, "x-fake-install": "inst-1" } }),
    badRequest: () => new Request("https://x/events", { method: "POST", headers: { "x-fake-signature": "nope" } }),
    messageEvent: { workspace: "T1", conversation: "C1", user: "U1", text: "we decided annual billing", ts: "1.0" },
    conversationId: "C1",
    binding: { id: "b1", install_id: "inst-1", conversation_id: "C1", nest_id: "n1" },
    view: { proposal_id: "p1", kind: "single", title: "Annual billing", summary: "s", folder: "decisions", nest_name: "Revenue", draft_url: "https://x/d" },
    surfaceUserId: "U1",
  };
});

describe("AC-CON-02: members() failures never yield a partial list", () => {
  const cases: Array<[string, "throw" | "timeout" | "incomplete" | "denied"]> = [
    ["throws", "throw"],
    ["times out", "timeout"],
    ["returns an incomplete page", "incomplete"],
    ["is denied", "denied"],
  ];
  for (const [label, fail] of cases) {
    it(`AC-CON-02: connector that ${label} → {known:false}`, async () => {
      const c = createFakeConnector();
      c.conversations.set("C1", { info: conversation("C1"), members: [member("U1")], fail });
      const r = await safeMembers(c, install, "C1", { timeoutMs: 50 });
      expect(r).toEqual({ known: false, reason: expect.any(String) });
      expect((r as any).members).toBeUndefined();
    });
  }

  it("AC-CON-02: a conversation the surface can't enumerate → {known:false}", async () => {
    const c = createFakeConnector();
    c.conversations.set("G1", { info: conversation("G1", { enumerable: false }), members: [member("U1")] });
    const r = await safeMembers(c, install, "G1", { timeoutMs: 50 });
    expect(r.known).toBe(false);
  });

  it("AC-CON-02: a malformed member list → {known:false}", async () => {
    const c = createFakeConnector();
    c.members = async () => ({ known: true, complete: true, members: "nope" } as any);
    const r = await safeMembers(c, install, "C1", { timeoutMs: 50 });
    expect(r.known).toBe(false);
  });

  it("AC-CON-02: a healthy connector → {known:true} with every member", async () => {
    const c = createFakeConnector();
    c.conversations.set("C1", { info: conversation("C1"), members: [member("U1"), member("U2")] });
    const r = await safeMembers(c, install, "C1", { timeoutMs: 500 });
    expect(r.known).toBe(true);
    if (r.known) expect(r.members.map((m) => m.surface_user_id)).toEqual(["U1", "U2"]);
  });
});

describe("AC-CON-03: core stays pure", () => {
  it("AC-CON-03: nothing under src/surfaces/core imports an adapter, the DB or network code", () => {
    const dir = join(process.cwd(), "src", "surfaces", "core");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      const specs = [...src.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3],
      );
      for (const s of specs) {
        const ok = s.startsWith("./") || s === "../contract.js";
        if (!ok) offenders.push(`${f}: ${s}`);
      }
      if (/\bfetch\s*\(|\bgetDb\b|XMLHttpRequest|WebSocket/.test(src)) offenders.push(`${f}: network/db call`);
    }
    expect(offenders).toEqual([]);
  });
});

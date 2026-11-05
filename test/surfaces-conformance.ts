/**
 * Surfaces M10 connector-contract conformance suite (AC-CON-01). Every adapter
 * (fake, Slack, Teams, email) runs this with its own fixture factory:
 *
 *   describeConnectorConformance("slack", () => slackFixture());
 *
 * The fixture supplies a connector plus inputs it knows how to answer: a
 * request that verifies, one that doesn't, a raw message event, a known
 * conversation and a binding to post into.
 */
import { describe, it, expect } from "vitest";
import { CONNECTOR_METHODS, type SurfaceConnector, type SurfaceInstallRef, type BindingRef, type ProposalView } from "../src/surfaces/contract.js";

export interface ConformanceFixture {
  connector: SurfaceConnector;
  install: SurfaceInstallRef;
  goodRequest: () => Request;
  badRequest: () => Request;
  messageEvent: unknown;
  conversationId: string;
  binding: BindingRef;
  view: ProposalView;
  surfaceUserId: string;
}

export function describeConnectorConformance(name: string, fixture: () => Promise<ConformanceFixture> | ConformanceFixture) {
  describe(`connector contract conformance: ${name}`, () => {
    it("AC-CON-01: implements every contract method", async () => {
      const f = await fixture();
      for (const m of CONNECTOR_METHODS) {
        expect(typeof (f.connector as any)[m], m).toBe("function");
      }
      expect(["slack", "teams", "email"]).toContain(f.connector.surface);
    });

    it("AC-CON-01: verify → {ok, install_id} | {ok:false, status}", async () => {
      const f = await fixture();
      const good = await f.connector.verify(f.goodRequest());
      expect(good.ok).toBe(true);
      if (good.ok) expect(typeof good.install_id).toBe("string");
      const bad = await f.connector.verify(f.badRequest());
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.status).toBeGreaterThanOrEqual(400);
    });

    it("AC-CON-01: normalize → SurfaceMessage[] with the §5.2 shape", async () => {
      const f = await fixture();
      const out = f.connector.normalize(f.messageEvent);
      expect(Array.isArray(out)).toBe(true);
      for (const m of out as any[]) {
        expect(Object.keys(m).sort()).toEqual(
          ["author", "conversation", "kind", "surface", "text", "thread", "ts", "workspace"].sort(),
        );
        expect(Object.keys(m.author).sort()).toEqual(["id", "is_bot", "is_external", "is_guest"]);
        expect(["message", "edit", "delete", "explicit_ask", "optout"]).toContain(m.kind);
      }
    });

    it("AC-CON-01: members → {known:true, complete:true, members[], conversation} with member flags", async () => {
      const f = await fixture();
      const r = await f.connector.members(f.install, f.conversationId);
      expect(r.known).toBe(true);
      if (r.known) {
        expect(r.complete).toBe(true);
        for (const m of r.members) {
          expect(Object.keys(m).sort()).toEqual(["home_tenant", "is_bot", "is_external", "is_guest", "surface_user_id"]);
        }
        expect(typeof r.conversation.is_private).toBe("boolean");
        expect(typeof r.conversation.is_ext_shared).toBe("boolean");
      }
    });

    it("AC-CON-01: postProposal is idempotent per proposal_id; updateProposal, sendPrivate, publishPending resolve", async () => {
      const f = await fixture();
      const a = await f.connector.postProposal(f.binding, f.view);
      const b = await f.connector.postProposal(f.binding, f.view);
      expect(a).toEqual(b);
      expect(a.surface).toBe(f.connector.surface);
      await expect(f.connector.updateProposal(a, f.view)).resolves.toBeUndefined();
      await expect(f.connector.sendPrivate(f.binding, f.surfaceUserId, f.view)).resolves.toBeUndefined();
      await expect(f.connector.publishPending(f.install, f.surfaceUserId, [])).resolves.toBeUndefined();
    });

    it("AC-CON-01: resolveIdentity → community user id or null", async () => {
      const f = await fixture();
      const id = await f.connector.resolveIdentity(f.install, f.surfaceUserId);
      expect(id === null || typeof id === "string").toBe(true);
    });
  });
}

/**
 * Surfaces S1 — the pure guard, card-model and reviewer rules (§4.10, §4.8 N4,
 * §12 R1). No DB, no app: computeGuard is fed reader sets and mapped members.
 */
import { describe, it, expect } from "vitest";
import { computeGuard, type GuardInput, type MappedMember, type ReaderSet } from "../src/surfaces/core/guard.js";
import { CARD_KINDS, guardView, type ProposalView } from "../src/surfaces/core/card-model.js";
import { routeReviewer } from "../src/surfaces/core/reviewers.js";
import { nextStatusAfterGuard } from "../src/surfaces/core/binding-state.js";
import type { ConversationInfo } from "../src/surfaces/contract.js";

const INSTALL = { bot_user_id: "B_OURS", home_tenant: "T1" };

function m(id: string, user: string | null, over: Partial<MappedMember> = {}): MappedMember {
  return { surface_user_id: id, is_guest: false, is_external: false, is_bot: false, home_tenant: "T1", community_user_id: user, ...over };
}
function conv(over: Partial<ConversationInfo> = {}): ConversationInfo {
  return { id: "C1", name: "#c", kind: "private_channel", is_private: true, is_ext_shared: false, is_general: false, enumerable: true, ...over };
}
function readers(users: string[], over: Partial<ReaderSet> = {}): ReaderSet {
  return { users, nonUser: [], universe: false, ...over };
}
function input(r: ReaderSet, members: MappedMember[] | null, c: ConversationInfo = conv(), b: Partial<GuardInput["binding"]> = {}): GuardInput {
  return {
    readers: r,
    serverAdmins: ["root"],
    members: members ? { known: true, members, conversation: c } : { known: false },
    binding: { conversation_kind: c.kind, explicit_public_bind: false, ext_capture_enabled: false, dm_owner_user_id: null, ...b },
    install: INSTALL,
  };
}

describe("guard: capture_ok (subset rule)", () => {
  it("AC-GRD-01: members map to every user reader, no non-user principals → capture_ok", () => {
    const g = computeGuard(input(readers(["u1", "u2"]), [m("S1", "u1"), m("S2", "u2"), m("S3", null)]));
    expect(g.capture_ok).toBe(true);
    expect(g.capture_basis).toBe("subset");
    expect(g.detail.readers_absent).toBe(0);
  });

  it("AC-GRD-09: public, non-ext-shared, no guests, explicit_public_bind → capture_ok even with absent readers", () => {
    const c = conv({ kind: "public_channel", is_private: false });
    const g = computeGuard(input(readers(["u1", "u2", "u3"]), [m("S1", "u1")], c, { explicit_public_bind: true }));
    expect(g.org_public).toBe(true);
    expect(g.capture_ok).toBe(true);
    expect(g.capture_basis).toBe("org_public");
  });

  it("AC-GRD-10: public channel with a single-channel guest → org_public false; subset rule only", () => {
    const c = conv({ kind: "public_channel", is_private: false });
    const withAbsent = computeGuard(
      input(readers(["u1", "u2"]), [m("S1", "u1"), m("G1", null, { is_guest: true })], c, { explicit_public_bind: true }),
    );
    expect(withAbsent.org_public).toBe(false);
    expect(withAbsent.capture_ok).toBe(false);
    const allPresent = computeGuard(
      input(readers(["u1"]), [m("S1", "u1"), m("G1", null, { is_guest: true })], c, { explicit_public_bind: true }),
    );
    expect(allPresent.capture_ok).toBe(true);
    expect(allPresent.capture_basis).toBe("subset");
  });

  it("AC-GRD-03/05/06/07 (pure): any non-user principal or UNIVERSE blocks capture for a non-public conversation", () => {
    for (const kind of ["key", "agent", "connector"] as const) {
      const g = computeGuard(input(readers(["u1"], { nonUser: [{ kind, id: "x" }] }), [m("S1", "u1")]));
      expect(g.capture_ok, kind).toBe(false);
      expect(g.detail.non_user_principals).toContain(kind);
    }
    const u = computeGuard(input(readers(["u1"], { universe: true }), [m("S1", "u1")]));
    expect(u.capture_ok).toBe(false);
    expect(u.detail.universe).toBe(true);
  });

  it("AC-GRD-13 (pure): ext-shared → capture off unless enabled; then evaluated; surface_ok stays false", () => {
    const c = conv({ is_ext_shared: true });
    const off = computeGuard(input(readers(["u1"]), [m("S1", "u1")], c));
    expect(off.capture_ok).toBe(false);
    const on = computeGuard(input(readers(["u1"]), [m("S1", "u1")], c, { ext_capture_enabled: true }));
    expect(on.capture_ok).toBe(true);
    expect(on.surface_ok).toBe(false);
    // explicit public bind never applies when ext-shared
    const pub = computeGuard(
      input(readers(["u1", "u2"]), [m("S1", "u1")], conv({ is_ext_shared: true, is_private: false, kind: "public_channel" }), {
        explicit_public_bind: true,
        ext_capture_enabled: true,
      }),
    );
    expect(pub.org_public).toBe(false);
    expect(pub.capture_ok).toBe(false);
  });

  it("AC-GRD-14 (pure): members unknown → both flags false", () => {
    const g = computeGuard(input(readers(["u1"]), null));
    expect(g.members_known).toBe(false);
    expect(g.capture_ok).toBe(false);
    expect(g.surface_ok).toBe(false);
  });
});

describe("guard: surface_ok", () => {
  it("AC-GRD-11: every member maps to a user reader → surface_ok; one non-reader → false with members_not_readers = 1", () => {
    const ok = computeGuard(input(readers(["u1", "u2"]), [m("S1", "u1"), m("S2", "u2")]));
    expect(ok.surface_ok).toBe(true);
    const one = computeGuard(input(readers(["u1", "u2"]), [m("S1", "u1"), m("S2", "u2"), m("S3", "u3")]));
    expect(one.surface_ok).toBe(false);
    expect(one.detail.members_not_readers).toBe(1);
  });

  it("AC-GRD-12: a guest or external member → surface_ok false even if their email matches a reader", () => {
    for (const flag of ["is_guest", "is_external"] as const) {
      // community_user_id would match a reader, but guests/externals never map
      const g = computeGuard(input(readers(["u1", "u2"]), [m("S1", "u1"), m("S2", "u2", { [flag]: true })]));
      expect(g.surface_ok, flag).toBe(false);
    }
  });

  it("AC-GRD-18 (amended by round-2 M7): our own bot is excluded; any other bot — home or external — makes surface_ok false, never capture_ok", () => {
    const ours = computeGuard(input(readers(["u1"]), [m("S1", "u1"), m("B_OURS", null, { is_bot: true })]));
    expect(ours.surface_ok).toBe(true);
    expect(ours.detail.members_total).toBe(1);
    const internal = computeGuard(
      input(readers(["u1"]), [m("S1", "u1"), m("B_OURS", null, { is_bot: true }), m("B_INT", null, { is_bot: true, home_tenant: "T1" })]),
    );
    expect(internal.surface_ok).toBe(false);
    expect(internal.capture_ok).toBe(true);
    expect(internal.detail.members_total).toBe(2);
    const external = computeGuard(input(readers(["u1"]), [m("S1", "u1"), m("B_EXT", null, { is_bot: true, home_tenant: "T9" })]));
    expect(external.surface_ok).toBe(false);
    expect(external.detail.externals).toBe(1);
  });

  it("surface_ok: a member who is a server admin can read the nest, so does not count as a non-reader", () => {
    const g = computeGuard(input(readers(["u1"]), [m("S1", "u1"), m("S9", "root")]));
    expect(g.surface_ok).toBe(true);
  });
});

describe("guard: DM bindings (§4.10, §12 R1)", () => {
  const dm = conv({ kind: "dm", is_private: true });
  it("AC-GRD-19: personal nest read only by U (server admins excluded) → both flags true", () => {
    const g = computeGuard(input(readers(["u1"]), [m("S1", "u1"), m("B_OURS", null, { is_bot: true })], dm, { dm_owner_user_id: "u1" }));
    expect(g.capture_ok).toBe(true);
    expect(g.surface_ok).toBe(true);
  });
  it("AC-GRD-19: any other principal reads the nest → both false", () => {
    for (const r of [readers(["u1", "u2"]), readers(["u1"], { nonUser: [{ kind: "agent", id: "a" }] }), readers(["u1"], { universe: true })]) {
      const g = computeGuard(input(r, [m("S1", "u1")], dm, { dm_owner_user_id: "u1" }));
      expect(g.capture_ok).toBe(false);
      expect(g.surface_ok).toBe(false);
    }
  });
  it("AC-GRD-19: a DM whose member is not the nest's owner → both false", () => {
    const g = computeGuard(input(readers(["u1"]), [m("S2", "u2")], dm, { dm_owner_user_id: "u1" }));
    expect(g.capture_ok).toBe(false);
  });
});

describe("guard detail is counts only", () => {
  it("guard_detail carries counts and kinds, never ids or names", () => {
    const g = computeGuard(input(readers(["u1", "u2"], { nonUser: [{ kind: "key", id: "secret-key-id" }] }), [m("S1", "u1")]));
    const s = JSON.stringify(g.detail);
    expect(s).not.toContain("secret-key-id");
    expect(s).not.toContain("u1");
    expect(s).not.toContain("S1");
    expect(g.detail).toMatchObject({ readers_total: 2, readers_absent: 1, members_total: 1, non_user_principals: ["key"] });
  });
});

describe("AC-GRD-20: nest-sourced strings never post when surface_ok is false", () => {
  const NEST_SOURCED = {
    on_record: "ON-RECORD-SECRET",
    existing_node_quote: "EXISTING-NODE-SECRET",
    existing_agent_config: "AGENT-CONFIG-SECRET",
    agent_answer: "AGENT-ANSWER-SECRET",
  };
  for (const kind of CARD_KINDS) {
    it(`AC-GRD-20: card kind "${kind}" is stripped or blocked`, () => {
      const view: ProposalView = {
        proposal_id: "p",
        kind,
        title: "Window title",
        summary: "Window summary",
        folder: "decisions",
        nest_name: "Revenue",
        draft_url: "https://x/d",
        nest_sourced: { ...NEST_SOURCED },
      };
      const out = guardView(view, { capture_ok: true, surface_ok: false });
      if (out.post) {
        const s = JSON.stringify(out.view);
        for (const secret of Object.values(NEST_SOURCED)) expect(s).not.toContain(secret);
        expect(out.redacted).toBe(true);
      } else {
        expect(out.view).toBeNull();
      }
      const open = guardView(view, { capture_ok: true, surface_ok: true });
      expect(open.post).toBe(true);
    });
  }
  it("AC-GRD-20: nothing posts at all without capture_ok", () => {
    const out = guardView(
      { proposal_id: "p", kind: "single", title: "t", summary: "s", folder: "f", nest_name: "n", draft_url: "u" },
      { capture_ok: false, surface_ok: false },
    );
    expect(out.post).toBe(false);
  });
});

describe("AC-GRD-21 (N4): held only under an explicit org-public bind", () => {
  it("AC-GRD-21: subset rule with ≥ 1 approver → never hold", () => {
    // under the subset rule every reader is a member, so every approver is present
    const r = routeReviewer({ captureBasis: "subset", approvers: ["u1", "u2"], memberUserIds: ["u1", "u2", "u3"] });
    expect(r.outcome).toBe("eligible");
    if (r.outcome === "eligible") expect(r.reviewers).toEqual(["u1", "u2"]);
  });
  it("AC-GRD-21: org-public bind with no in-conversation approver → hold", () => {
    const r = routeReviewer({ captureBasis: "org_public", approvers: ["u9"], memberUserIds: ["u1"] });
    expect(r.outcome).toBe("hold");
  });
  it("AC-GRD-21: nest with no approver at all → hold", () => {
    const r = routeReviewer({ captureBasis: "subset", approvers: [], memberUserIds: ["u1"] });
    expect(r.outcome).toBe("hold");
  });
});

describe("binding state machine (§12): guard transitions", () => {
  it("active + capture lost → paused_guard; paused_guard never silently resumes; member/removed states are sticky", () => {
    expect(nextStatusAfterGuard("active", false)).toEqual({ status: "paused_guard", paused: true });
    expect(nextStatusAfterGuard("active", true)).toEqual({ status: "active", paused: false });
    expect(nextStatusAfterGuard("paused_guard", true)).toEqual({ status: "paused_guard", paused: false });
    expect(nextStatusAfterGuard("paused_by_member", true)).toEqual({ status: "paused_by_member", paused: false });
    expect(nextStatusAfterGuard("removed", true)).toEqual({ status: "removed", paused: false });
  });
});

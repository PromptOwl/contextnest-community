/**
 * Surfaces S1: an in-memory connector implementing the M10 contract. No
 * network. Tests drive conversations, members and user profiles directly.
 */
import type {
  CardRef,
  ConversationInfo,
  MembersResult,
  ProposalView,
  SurfaceConnector,
  SurfaceInstallRef,
  SurfaceMember,
  SurfaceMessage,
  SurfaceSignal,
  SurfaceUserProfile,
  BindingRef,
} from "../src/surfaces/contract.js";

export interface FakeConversation {
  info: ConversationInfo;
  members: SurfaceMember[];
  /** Simulated failure of members(). */
  fail?: "throw" | "timeout" | "incomplete" | "denied";
}

export interface FakeConnector extends SurfaceConnector {
  conversations: Map<string, FakeConversation>;
  profiles: Map<string, SurfaceUserProfile>;
  posted: Array<{ ref: CardRef; view: ProposalView; proposal_id: string }>;
  updated: Array<{ ref: CardRef; view: ProposalView }>;
  privates: Array<{ surfaceUserId: string; view: ProposalView }>;
  pending: Array<{ surfaceUserId: string; items: unknown[] }>;
  /**
   * Hold the NEXT members() call for this conversation until released — lets a
   * test interleave other operations deterministically (no sleeps).
   */
  gate(conversationId: string): { entered: Promise<void>; release: () => void };
  /** Hook for resolveIdentity — set by the test to the identity service. */
  identity?: (installId: string, surfaceUserId: string) => Promise<string | null>;
}

export const FAKE_SECRET = "fake-signing-secret";

export function member(id: string, over: Partial<SurfaceMember> = {}): SurfaceMember {
  return { surface_user_id: id, is_guest: false, is_external: false, is_bot: false, home_tenant: "T1", ...over };
}

export function conversation(id: string, over: Partial<ConversationInfo> = {}): ConversationInfo {
  return {
    id,
    name: `#${id}`,
    kind: "private_channel",
    is_private: true,
    is_ext_shared: false,
    is_general: false,
    enumerable: true,
    ...over,
  };
}

export function profile(id: string, over: Partial<SurfaceUserProfile> = {}): SurfaceUserProfile {
  return {
    surface_user_id: id,
    home_team_id: "T1",
    enterprise_id: null,
    email: null,
    email_confirmed: true,
    is_restricted: false,
    is_ultra_restricted: false,
    is_stranger: false,
    is_bot: false,
    deleted: false,
    user_role: null,
    display_name: id,
    ...over,
  };
}

export function createFakeConnector(surface: "slack" | "teams" | "email" = "slack"): FakeConnector {
  const conversations = new Map<string, FakeConversation>();
  const profiles = new Map<string, SurfaceUserProfile>();
  const posted: FakeConnector["posted"] = [];
  const updated: FakeConnector["updated"] = [];
  const privates: FakeConnector["privates"] = [];
  const pending: FakeConnector["pending"] = [];
  const byProposal = new Map<string, CardRef>();
  const gates = new Map<string, { enter: () => void; wait: Promise<void> }>();

  function membersNow(conversationId: string): Promise<MembersResult> | MembersResult {
    const c = conversations.get(conversationId);
    if (!c) return { known: false, reason: "not_found" };
    if (c.fail === "throw") throw new Error("members api exploded");
    if (c.fail === "timeout") return new Promise(() => {});
    if (c.fail === "denied") return { known: false, reason: "denied" };
    return {
      known: true,
      complete: c.fail === "incomplete" ? (false as any) : true,
      members: c.members.map((m) => ({ ...m })),
      conversation: { ...c.info },
    } as MembersResult;
  }

  const fake: FakeConnector = {
    surface,
    conversations,
    profiles,
    posted,
    updated,
    privates,
    pending,
    async verify(req: Request) {
      const sig = req.headers.get("x-fake-signature");
      const install = req.headers.get("x-fake-install");
      if (sig === FAKE_SECRET && install) return { ok: true as const, install_id: install };
      return { ok: false as const, status: 401 };
    },
    normalize(event: any): SurfaceMessage[] | SurfaceSignal {
      if (event?.type === "member_left" || event?.type === "member_joined") {
        return {
          surface,
          workspace: event.workspace,
          kind: event.type,
          conversation: event.conversation,
          user: event.user,
        };
      }
      return [
        {
          surface,
          workspace: event.workspace,
          conversation: event.conversation,
          thread: event.thread ?? null,
          author: { id: event.user, is_bot: !!event.bot, is_guest: false, is_external: false },
          text: String(event.text ?? ""),
          ts: String(event.ts ?? "0"),
          kind: "message",
        },
      ];
    },
    gate(conversationId: string) {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => (enter = r));
      const wait = new Promise<void>((r) => (release = r));
      gates.set(conversationId, { enter, wait });
      return { entered, release };
    },
    async members(_install: SurfaceInstallRef, conversationId: string): Promise<MembersResult> {
      const g = gates.get(conversationId);
      if (g) {
        // Snapshot the list NOW (as a real API call would), then hold it.
        gates.delete(conversationId);
        const snapshot = membersNow(conversationId);
        g.enter();
        await g.wait;
        return snapshot;
      }
      return membersNow(conversationId);
    },
    async userProfile(_install: SurfaceInstallRef, surfaceUserId: string) {
      const p = profiles.get(surfaceUserId);
      return p ? { ...p } : null;
    },
    async postProposal(binding: BindingRef, view: ProposalView) {
      const existing = byProposal.get(view.proposal_id);
      if (existing) return existing;
      const ref: CardRef = { surface, conversation: binding.conversation_id, message_ref: `m-${posted.length + 1}` };
      byProposal.set(view.proposal_id, ref);
      posted.push({ ref, view, proposal_id: view.proposal_id });
      return ref;
    },
    async updateProposal(ref: CardRef, view: ProposalView) {
      updated.push({ ref, view });
    },
    async resolveIdentity(install: SurfaceInstallRef, surfaceUserId: string) {
      return fake.identity ? fake.identity(install.id, surfaceUserId) : null;
    },
    async sendPrivate(_binding: BindingRef, surfaceUserId: string, view: ProposalView) {
      privates.push({ surfaceUserId, view });
    },
    async publishPending(_install: SurfaceInstallRef, surfaceUserId: string, items: unknown[]) {
      pending.push({ surfaceUserId, items });
    },
  };
  return fake;
}

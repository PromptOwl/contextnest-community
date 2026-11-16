/**
 * The binding guard (PRD §4.10, amended by §12 R1). Pure: the binding service
 * computes EffectiveReaders from Community permissions and maps conversation
 * members to Community users; this decides the two flags.
 *
 * - `capture_ok`: every reader is in the room, or the room is org-public and
 *   the admin bound it on purpose.
 * - `surface_ok`: everyone in the room can read the nest.
 *
 * Server admins (license admin + superadmins) hold `admin` on every nest and
 * cannot be removed, so they are NOT in `readers` (the service leaves them
 * out) and every binding carries the disclosure instead (§12 R1). They still
 * count as able to read for `surface_ok`, because they can.
 *
 * Fails closed: unknown members → both flags false.
 */
import type { ConversationInfo, ConversationKind, SurfaceMember } from "../contract.js";

export type NonUserKind = "key" | "agent" | "connector" | "support" | "anon";

export interface ReaderSet {
  /** Community user ids that read the nest by any path except the
   *  server-admin one (owner, collaborators, teams, stewards, grants). */
  users: string[];
  /** Readers that are not a person who could be in the room. */
  nonUser: Array<{ kind: NonUserKind; id: string }>;
  /** Public or link-shared: anyone in the world can read. */
  universe: boolean;
  /** Visibility `org`: every account on this (single-company) deployment
   *  reads it. Blocks the subset rule, but an org-public channel may still
   *  feed it by explicit bind (§12 round-2 M4). On a shared deployment the
   *  service reports `universe` instead. */
  orgWide?: boolean;
}

export interface MappedMember extends SurfaceMember {
  /** The Community user this member maps to (active link or auto-match), or
   *  null. Guests and externals never map, whatever this says. */
  community_user_id: string | null;
}

export interface GuardInput {
  readers: ReaderSet;
  /** Community user ids of server admins (readers by the exempt path). */
  serverAdmins: string[];
  members: { known: true; members: MappedMember[]; conversation: ConversationInfo } | { known: false };
  binding: {
    conversation_kind: ConversationKind;
    explicit_public_bind: boolean;
    ext_capture_enabled: boolean;
    dm_owner_user_id?: string | null;
  };
  install: { bot_user_id: string | null; home_tenant: string };
}

export interface GuardDetail {
  readers_total: number;
  readers_absent: number;
  members_total: number;
  members_not_readers: number;
  guests: number;
  externals: number;
  non_user_principals: NonUserKind[];
  universe: boolean;
  org_wide: boolean;
  ext_shared: boolean;
  server_admins_disclosed: true;
}

export interface GuardResult {
  capture_ok: boolean;
  surface_ok: boolean;
  members_known: boolean;
  org_public: boolean;
  /** Which rule granted capture: the subset rule or the explicit org-public
   *  bind (drives N4 routing: only the latter can hold). */
  capture_basis: "subset" | "org_public" | null;
  detail: GuardDetail;
}

export const SERVER_ADMIN_DISCLOSURE = "This server's administrators can read every nest.";

function uniqueKinds(r: ReaderSet): NonUserKind[] {
  return [...new Set(r.nonUser.map((p) => p.kind))].sort();
}

/**
 * Only our own app's bot is not a member. Every other bot — home workspace
 * or external — is a member who can't read the nest, so it turns surface_ok
 * off (a note-taker or archiver would ingest nest text). Bots don't block
 * capture: they don't author keep-worthy content and are dropped at the gate.
 */
export function isExcludedBot(m: SurfaceMember, install: GuardInput["install"]): boolean {
  return m.is_bot && !!install.bot_user_id && m.surface_user_id === install.bot_user_id;
}

export function computeGuard(input: GuardInput): GuardResult {
  const { readers, install, binding } = input;
  const readerSet = new Set(readers.users);
  const nonUserKinds = uniqueKinds(readers);

  if (!input.members.known) {
    return {
      capture_ok: false,
      surface_ok: false,
      members_known: false,
      org_public: false,
      capture_basis: null,
      detail: {
        readers_total: readerSet.size,
        readers_absent: readerSet.size,
        members_total: 0,
        members_not_readers: 0,
        guests: 0,
        externals: 0,
        non_user_principals: nonUserKinds,
        universe: readers.universe,
        org_wide: !!readers.orgWide,
        ext_shared: false,
        server_admins_disclosed: true,
      },
    };
  }

  const conv = input.members.conversation;
  const members = input.members.members.filter((m) => !isExcludedBot(m, install));
  // An external bot (home team ≠ install) is kept and counted as external.
  const isExternal = (m: MappedMember) => m.is_external || (m.is_bot && m.home_tenant !== install.home_tenant);
  // Bots never map to a Community user (and so never count as readers).
  const isBot = (m: MappedMember) => m.is_bot;
  const guests = members.filter((m) => m.is_guest).length;
  const externals = members.filter((m) => !m.is_guest && isExternal(m)).length;
  const mapsTo = (m: MappedMember): string | null => (m.is_guest || isExternal(m) || isBot(m) ? null : m.community_user_id);

  const present = new Set(members.map(mapsTo).filter((u): u is string => !!u));
  const readersAbsent = [...readerSet].filter((u) => !present.has(u)).length;
  const canRead = (u: string | null) => !!u && (readerSet.has(u) || input.serverAdmins.includes(u));
  const membersNotReaders = members.filter((m) => !canRead(mapsTo(m))).length;

  const allReadersPresent = readers.nonUser.length === 0 && !readers.universe && !readers.orgWide && readersAbsent === 0;
  const extShared = conv.is_ext_shared;
  const orgPublic = !conv.is_private && !extShared && guests === 0 && externals === 0;
  const extOk = !extShared || binding.ext_capture_enabled;
  // The explicit org-public bind relaxes ONLY the user-reader subset rule: the
  // nest must still not be world-readable / link-shared, and nothing but
  // people (and this binding's listener) may read it — no keys, other agents
  // or outbound connectors (§12 round-2 M4).
  const publicBind =
    orgPublic && binding.explicit_public_bind && !extShared && !readers.universe && readers.nonUser.length === 0;

  let capture_ok: boolean;
  let surface_ok: boolean;
  let capture_basis: GuardResult["capture_basis"] = null;

  if (binding.conversation_kind === "dm") {
    // EffectiveReaders must be exactly {the DM's owner}, and the DM's member
    // must be that person.
    const owner = binding.dm_owner_user_id ?? null;
    const exact =
      !!owner &&
      readers.nonUser.length === 0 &&
      !readers.universe &&
      !readers.orgWide &&
      readerSet.size === 1 &&
      readerSet.has(owner) &&
      members.length > 0 &&
      members.every((m) => mapsTo(m) === owner);
    capture_ok = exact && extOk && !extShared;
    surface_ok = capture_ok;
    if (capture_ok) capture_basis = "subset";
  } else {
    if (allReadersPresent && extOk) {
      capture_ok = true;
      capture_basis = "subset";
    } else if (publicBind && extOk) {
      capture_ok = true;
      capture_basis = "org_public";
    } else {
      capture_ok = false;
    }
    surface_ok = !extShared && guests === 0 && externals === 0 && membersNotReaders === 0;
  }

  return {
    capture_ok,
    surface_ok,
    members_known: true,
    org_public: orgPublic,
    capture_basis,
    detail: {
      readers_total: readerSet.size,
      readers_absent: readersAbsent,
      members_total: members.length,
      members_not_readers: membersNotReaders,
      guests,
      externals,
      non_user_principals: nonUserKinds,
      universe: readers.universe,
      org_wide: !!readers.orgWide,
      ext_shared: extShared,
      server_admins_disclosed: true,
    },
  };
}

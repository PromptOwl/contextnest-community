/**
 * My Work — the cross-nest inbox behind GET /me/work and MCP
 * `context_my_work` (PO-1180). One function, so the two surfaces return the
 * same sections and the same items by construction (AC-MW-05).
 *
 * Sections: `items` (reviews, deletion flags and access requests waiting on
 * the caller), `waiting` (what the caller handed off), `notifications`
 * (unread inbox rows), `assigned` (open board cards), and `mentions` (open
 * comment threads, in channels and on documents, that @mention the caller and
 * wait on their answer). `waiting_on_me_total` is the badge's share of the
 * server-counted sections; the UI adds assigned + notifications
 * (ui/src/lib/my-work-groups.ts waitingOnMeCount).
 *
 * Moved out of app.ts unchanged except for the mentions section, the
 * mention-notification dedupe, and the optional single-nest scope.
 *
 * PO-1190 (AC-AX-01/02): `sections` returns only the sections asked for (and
 * skips the work behind the rest), an explicit `limit` caps every section,
 * and `actingAs` adds the threads that tag the agent this call is acting as.
 */
import { listVisibleNests, nestAllowsSelfApprove } from "../nests/service.js";
import { getReviewQueue, listDeletionRequests } from "../governance/review-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { resolveUserRoles } from "../governance/stewardship-service.js";
import { listNotifications } from "../governance/notify-service.js";
import { canDecideAccessRequests, listAccessRequests } from "../governance/access-request-service.js";
import { listAssignedTo } from "../nodes/assigned-service.js";
import { listOpenMentions, mentionedNodeKeys } from "../mentions/mention-index.js";
import { ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { chatUnreadSummary } from "../chat/unread.js";

/** The sections of My Work, in the order an agent reads them. `chat` (the
 *  team chat unread summary, C2 PO-1197) exists only while TEAM_CHAT_ENABLED
 *  is on; `myWorkSections()` is the live list. */
export const MY_WORK_SECTIONS = ["mentions", "items", "assigned", "waiting", "notifications", "chat"] as const;
export type MyWorkSection = (typeof MY_WORK_SECTIONS)[number];
export function myWorkSections(): readonly MyWorkSection[] {
  return config.TEAM_CHAT_ENABLED ? MY_WORK_SECTIONS : MY_WORK_SECTIONS.filter((s) => s !== "chat");
}

/** `sections` from a query string ("mentions,items") or an MCP argument
 *  (["mentions", "items"]); null when none was given. */
export function parseMyWorkSections(raw: unknown): MyWorkSection[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out: MyWorkSection[] = [];
  for (const item of list) {
    const s = String(item ?? "").trim().toLowerCase();
    if (!s) continue;
    if (!(myWorkSections() as readonly string[]).includes(s)) {
      throw new ValidationError(`sections takes any of: ${myWorkSections().join(", ")}.`);
    }
    if (!out.includes(s as MyWorkSection)) out.push(s as MyWorkSection);
  }
  return out.length ? out : null;
}

/** Default and largest page of mentions. */
export const MENTIONS_PAGE_DEFAULT = 50;
export const MENTIONS_PAGE_MAX = 100;
const MAX_MENTIONS_OFFSET = 10_000;

// Short-TTL cache for the /me/work approve-capability check. The dashboard
// polls this inbox, and a caller's nest roles change rarely — so caching the
// per-(nest, user) "can approve here?" boolean for a few seconds skips the
// repeated resolveUserRoles round-trips on each poll, without holding stale
// governance long enough to matter. Global map (single-process server).
const APPROVE_CACHE_TTL_MS = 30_000;
const approveCache = new Map<string, { ok: boolean; exp: number }>();
async function canApproveInNest(nestId: string, email: string): Promise<boolean> {
  const key = `${nestId} ${email.toLowerCase()}`;
  const now = Date.now();
  const hit = approveCache.get(key);
  if (hit && hit.exp > now) return hit.ok;
  // MUST mirror canUserApprove's nest-level gate, not the pure canApproveWith:
  // admin/reviewer approve always, but a BARE owner (no admin/reviewer steward
  // role) can only approve when the nest allows self-approve. Using
  // canApproveWith here — which treats "owner" as always approve-capable — put
  // a dead Approve button back in front of owners who delegated approval to a
  // reviewer and left self-approve off (the default SoD setup). Fetch the flag
  // only for the owner-only case so reviewers/admins skip the extra read.
  const roles = await resolveUserRoles(nestId, email);
  let ok = roles.includes("admin") || roles.includes("reviewer");
  if (!ok && roles.includes("owner")) ok = await nestAllowsSelfApprove(nestId);
  // Cheap bound: sweep expired entries when the map grows, so a long-running
  // server polling /me/work across many (nest, user) pairs doesn't accumulate
  // stale keys forever. O(n) but only past a threshold, amortized to nothing.
  if (approveCache.size > 500) {
    for (const [k, v] of approveCache) if (v.exp <= now) approveCache.delete(k);
  }
  approveCache.set(key, { ok, exp: now + APPROVE_CACHE_TTL_MS });
  return ok;
}

/**
 * The paging knobs, from query params or MCP arguments alike. limit/offset
 * page the review queue (as before); mentions_limit defaults to `limit`,
 * mentions_offset to 0.
 */
export function parseMyWorkPaging(q: {
  limit?: unknown;
  offset?: unknown;
  mentions_limit?: unknown;
  mentions_offset?: unknown;
}) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const mentionsLimit = Math.min(
    Math.max(Number(q.mentions_limit) || (q.limit != null ? limit : MENTIONS_PAGE_DEFAULT), 1),
    MENTIONS_PAGE_MAX,
  );
  const mentionsOffset = Math.min(Math.max(Math.floor(Number(q.mentions_offset) || 0), 0), MAX_MENTIONS_OFFSET);
  // An explicit limit caps every section, not only the review page (AC-AX-02).
  const sectionLimit = q.limit != null && q.limit !== "" && Number(q.limit) > 0 ? limit : null;
  return { limit, offset, mentionsLimit, mentionsOffset, sectionLimit };
}

export async function buildMyWork(params: {
  userId: string;
  limit: number;
  offset: number;
  mentionsLimit: number;
  mentionsOffset: number;
  /** Restrict every section to this one nest (a nest-scoped credential). */
  onlyNestId?: string | null;
  /** Return only these sections (and skip the work behind the others). */
  sections?: MyWorkSection[] | null;
  /** Cap every section at this many rows (an explicit `limit`). */
  sectionLimit?: number | null;
  /** The agent handle this call is acting as (mention-index actingAgentHandle). */
  actingAs?: string | null;
}) {
  const { userId, limit, offset, mentionsLimit, mentionsOffset, onlyNestId } = params;
  const sections = params.sections?.length ? params.sections : null;
  const want = (s: MyWorkSection) => !sections || sections.includes(s);
  // Reviews, deletion flags and access requests fill `items` and `waiting`.
  const wantQueue = want("items") || want("waiting");
  const me = await resolveCallerEmail(userId);
  const nestName = new Map<string, string>();
  for (const n of await listVisibleNests(userId)) {
    // A nest-scoped credential (MCP context_my_work on a scoped key) sees
    // its own nest's work only — the same fence that keeps such a key off
    // GET /me/work altogether (auth/nest-scope-guard.ts).
    if (onlyNestId && n.id !== onlyNestId) continue;
    nestName.set(n.id, n.name ?? n.id);
  }

  // Page the queue — 50 at a time by default — instead of pulling 200 up
  // front. limit/offset are query params (?limit=&offset=), clamped to sane
  // bounds. Scoping to the caller's visible nests up front also keeps
  // getReviewQueue from title-mapping (= filesystem-scanning) nests they
  // can't see.
  const { requests, total } = wantQueue
    ? await getReviewQueue({
        status: "pending",
        nestIds: [...nestName.keys()],
        limit,
        offset,
      })
    : { requests: [], total: 0 };
  const toItem = (r: (typeof requests)[number]) => ({
    type: "review" as const,
    nest_id: r.nestId,
    nest_name: nestName.get(r.nestId)!,
    node_id: r.nodeId,
    title: r.title || r.nodeId,
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    priority: r.priority,
    // Filed by an agent run (migration 060): the inbox links to its trace.
    run_id: r.runId ?? null,
  });
  // Deletion flags ride the same inbox, as a second item type: `reason` and
  // `request_id` are the extra fields resolving one needs.
  const deletions = wantQueue
    ? await listDeletionRequests({
        nestIds: [...nestName.keys()],
        status: "pending",
      })
    : [];
  const toDeletionItem = (r: (typeof deletions)[number]) => ({
    type: "deletion" as const,
    nest_id: r.nestId,
    nest_name: nestName.get(r.nestId)!,
    node_id: r.nodeId,
    title: r.title || r.nodeId,
    requested_by: r.requestedBy,
    requested_at: r.createdAt,
    priority: "normal" as const,
    reason: r.reason,
    request_id: r.id,
    // node_id holds a folder path / nest id for those targets, so a client
    // must not treat it as a document to open.
    target_type: r.targetType,
  });
  // Access requests (CU-wdqcq041jn) are a third item type: someone asked to
  // edit something they can only read. node_id is the document for a node
  // target, else the folder path / nest id — target_type says which.
  // Capped (500, newest first), not paginated: a person can have at most
  // MAX_PENDING_PER_NEST waiting per nest, so the pending set stays small;
  // the count below reflects what is shown.
  // Decider nests first, so only rows this caller can act on (or filed) load.
  const deciderNestIds = (
    await Promise.all(
      (wantQueue ? [...nestName.keys()] : []).map(async (id) =>
        (await canDecideAccessRequests(id, userId)) ? id : null,
      ),
    )
  ).filter((id): id is string => id !== null);
  const [decidable, myAccessAsks] = !wantQueue ? [[], []] : await Promise.all([
    listAccessRequests({ nestIds: deciderNestIds, status: "pending", limit: 500 }),
    listAccessRequests({
      nestIds: [...nestName.keys()],
      requesterId: userId,
      status: "pending",
      limit: 500,
    }),
  ]);
  const toAccessItem = (r: (typeof decidable)[number]) => ({
    type: "access" as const,
    nest_id: r.nest_id,
    nest_name: nestName.get(r.nest_id)!,
    node_id: r.target_id,
    title: r.title || r.target_id,
    requested_by: r.requested_by,
    requested_at: r.created_at,
    priority: "normal" as const,
    reason: r.note ?? "",
    request_id: r.id,
    target_type: r.target_type,
    level: r.level,
    run_id: r.run_id ?? null,
  });
  type WorkItem =
    | ReturnType<typeof toItem>
    | ReturnType<typeof toDeletionItem>
    | ReturnType<typeof toAccessItem>;
  const byNewest = (a: { requested_at: string }, b: { requested_at: string }) =>
    a.requested_at < b.requested_at ? 1 : -1;
  // items = waiting on ME (someone else asked); waiting = I asked, waiting on them.
  // An editor/viewer can SEE a nest but can't approve — the "waiting on me"
  // bucket must only surface reviews this caller can actually action, else the
  // inbox nags editors/viewers to approve work they have no rights over.
  // Approve capability is a nest-level property here (a reviewer/admin role
  // anywhere on the nest, or the owner with self-approve), so resolve it ONCE
  // per distinct nest — not per request — in parallel. Bounded by nest count,
  // not queue length, so no per-item latency blowup.
  // ponytail: nest-granularity check. A reviewer scoped to only one doc/tag
  // will see that whole nest's pending items, not just their scoped docs.
  // Tighten to per-node canUserApprove if that over-inclusion ever matters.
  // Resolved for every nest the caller can SEE, not just nests that happen
  // to appear in this page of `requests` — pagination.total below needs
  // the full picture (a nest with pending reviews from someone else, on a
  // page the caller never fetched, still has to be excluded consistently).
  const others = requests.filter((r) => r.requestedBy !== me);
  const nestApprove = new Map<string, boolean>(
    await Promise.all(
      (wantQueue ? [...nestName.keys()] : []).map(
        async (nestId): Promise<[string, boolean]> => [
          nestId,
          await canApproveInNest(nestId, me),
        ],
      ),
    ),
  );
  const items: WorkItem[] = others
    .filter((r) => nestApprove.get(r.nestId))
    .map(toItem);
  const waiting: WorkItem[] = requests
    .filter((r) => r.requestedBy === me)
    .map(toItem);

  // Waiting-on-me for the nest admins/owners who can action a flag,
  // waiting-on-others for whoever asked. Deliberately NOT folded into the
  // review queue's pagination — the flag set is small, and merging two
  // offsets into one cursor buys nothing.
  const othersDeletions = deletions.filter((r) => r.requestedBy !== me);
  // Deleting is an owner/admin call (the same tier the UI shows Delete to),
  // NOT the approve capability reviews use — resolved once per nest.
  const nestManage = new Map<string, boolean>(
    await Promise.all(
      [...new Set(othersDeletions.map((r) => r.nestId))].map(
        async (nestId): Promise<[string, boolean]> => {
          const roles = await resolveUserRoles(nestId, me);
          return [nestId, roles.includes("owner") || roles.includes("admin")];
        },
      ),
    ),
  );
  items.push(
    ...othersDeletions
      .filter((r) => nestManage.get(r.nestId))
      .map(toDeletionItem),
  );
  // Waiting on me: asks I can decide. Waiting on others: the ones I filed.
  items.push(
    ...decidable.filter((r) => r.requester_id !== userId).map(toAccessItem),
  );
  items.sort(byNewest);
  waiting.push(
    ...deletions.filter((r) => r.requestedBy === me).map(toDeletionItem),
    ...myAccessAsks.map(toAccessItem),
  );
  waiting.sort(byNewest);
  // Watcher notifications (HITL tags) ride along so the inbox is one call.
  // Scoped to the visible nests only for a nest-scoped credential; the REST
  // inbox keeps listing every unread row, as it always has. A comment
  // "mentioned you" row is dropped when the Mentions section below carries
  // that same mention (PO-1180) — one event, counted once in the badge.
  const mentionedNodes = !want("notifications")
    ? new Set<string>()
    : await mentionedNodeKeys(userId, [...nestName.keys()]).catch((err) => {
        console.error("[me/work] mention keys failed", err);
        return new Set<string>();
      });
  const notifications = (want("notifications") ? await listNotifications(me, { unreadOnly: true, limit: 50 }) : []).filter(
    (n: { nest_id: string; kind: string; node_id?: string | null; subject_id?: string | null }) =>
      (!onlyNestId || n.nest_id === onlyNestId) &&
      !(n.kind === "mention" && mentionedNodes.has(`${n.nest_id}\u0000${n.node_id ?? n.subject_id ?? ""}`)),
  );
  // `total` from getReviewQueue counts every PENDING REVIEW across every
  // nest the caller can see — full stop, regardless of who requested it or
  // whether the caller can approve it. But items/waiting only ever surface
  // a review that is either the caller's own request or one the caller can
  // actually approve (see nestApprove above); a review from someone else in
  // a nest where the caller is a bare viewer/editor never appears in either
  // bucket, yet was still counted in `total` — so the badge (which reads
  // pagination.total, see my-work/meta.ts) overcounted relative to what My
  // Work actually shows. Recompute the review portion of the total as
  // exactly (pending reviews in nests the caller can approve) + (the
  // caller's own pending reviews elsewhere) — the same two conditions
  // items/waiting are built from — via two SQL counts rather than the raw,
  // unfiltered getReviewQueue total.
  const approvableNestIds = [...nestName.keys()].filter((id) =>
    nestApprove.get(id),
  );
  const restNestIds = [...nestName.keys()].filter(
    (id) => !nestApprove.get(id),
  );
  const [
    { total: approvableReviewTotal },
    { total: myReviewsElsewhereTotal },
    { total: myReviewsTotal },
  ] = !wantQueue ? [{ total: 0 }, { total: 0 }, { total: 0 }] : await Promise.all([
    getReviewQueue({ status: "pending", nestIds: approvableNestIds, limit: 1 }),
    getReviewQueue({
      status: "pending",
      nestIds: restNestIds,
      requestedByEmail: me,
      limit: 1,
    }),
    getReviewQueue({
      status: "pending",
      nestIds: [...nestName.keys()],
      requestedByEmail: me,
      limit: 1,
    }),
  ]);
  const reviewTotal = approvableReviewTotal + myReviewsElsewhereTotal;
  // Deletion flags and access requests ride the same two buckets (above)
  // but aren't paginated (both lists fetch every pending one), so folding in
  // however many are actually shown keeps the total exact regardless of
  // which review page this call fetched.
  const requestsShown =
    items.filter((i) => i.type === "deletion" || i.type === "access").length +
    waiting.filter((i) => i.type === "deletion" || i.type === "access").length;
  // Board cards assigned to me (open ones), across every nest I can see.
  // Best-effort: a failure here must not take the reviews inbox down with it.
  const assigned = !want("assigned")
    ? []
    : await listAssignedTo(me, userId, nestName).catch((err) => {
        console.error("[me/work] assigned list failed", err);
        return [];
      });
  // Open threads that @mention the caller and wait on their answer
  // (PO-1180), across the same visible nests, access-checked per node. Paged
  // on their own cursor; the whole filtered list is counted, so the badge
  // and mentions_pagination.total are exactly what the pages can show.
  const allMentions = !want("mentions")
    ? []
    : await listOpenMentions({ userId, email: me, nestNames: nestName, actingAs: params.actingAs ?? null }).catch((err) => {
        console.error("[me/work] mentions list failed", err);
        return [];
      });
  const mentions = allMentions.slice(mentionsOffset, mentionsOffset + mentionsLimit);
  // The badge's share (CU-wdqcq0658p): the same total minus what waits on
  // others — the caller's own pending reviews and the requests they filed.
  // Plus every open mention (all pages), each counted once.
  const waitingOnMeTotal =
    reviewTotal + requestsShown - myReviewsTotal -
    waiting.filter((i) => i.type === "deletion" || i.type === "access").length +
    allMentions.length;
  const cap = <T>(rows: T[]): T[] => (params.sectionLimit ? rows.slice(0, params.sectionLimit) : rows);
  // Team chat C2 (PO-1197): the app-wide unread summary, while chat is on.
  const chat =
    config.TEAM_CHAT_ENABLED && want("chat")
      ? await chatUnreadSummary({ userId, email: me, onlyNestId, actingAs: params.actingAs ?? null }).catch((err) => {
          console.error("[my-work] chat unread failed", err);
          return undefined;
        })
      : undefined;
  const full = {
    ...(chat ? { chat } : {}),
    items: cap(items),
    waiting: cap(waiting),
    notifications: cap(notifications),
    assigned: cap(assigned),
    mentions,
    waiting_on_me_total: waitingOnMeTotal,
    pagination: {
      total: reviewTotal + requestsShown,
      limit,
      offset,
      has_more: offset + requests.length < total,
    },
    mentions_pagination: {
      total: allMentions.length,
      limit: mentionsLimit,
      offset: mentionsOffset,
      has_more: mentionsOffset + mentions.length < allMentions.length,
    },
  };
  if (!sections) return full as Partial<typeof full>;
  // Only what was asked for. The totals span sections, so they ride only on
  // the full response; each asked section keeps its own paging.
  const out: Partial<typeof full> = {};
  for (const s of sections) (out as Record<string, unknown>)[s] = full[s];
  if (wantQueue) out.pagination = full.pagination;
  if (want("mentions")) out.mentions_pagination = full.mentions_pagination;
  return out;
}

export type MyWork = Awaited<ReturnType<typeof buildMyWork>>;

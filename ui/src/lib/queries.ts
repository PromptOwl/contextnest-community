/**
 * Shared client-side read cache.
 *
 * Every screen used to fetch on mount into its own state and throw it away on
 * unmount, so bouncing between a nest and a document re-fetched the listing
 * each time and showed a spinner for data the user had just seen. These
 * definitions put all of those reads behind one cache: a revisit paints
 * immediately from memory and revalidates in the background, and two components
 * asking for the same thing at once produce one request.
 *
 * Reads live here; the api module keeps owning the wire format and mutations.
 */

import { QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import * as api from "./api";

/**
 * Query keys, shaped as a hierarchy so invalidation can name either one entry
 * or a whole family. Everything scoped to a nest sits under `nest(id)`, and
 * everything scoped to a document under `node(nestId, nodeId)`, so invalidating
 * a prefix drops the whole subtree in one call while siblings are untouched.
 *
 * Literal segments ("detail", "nodes", …) sit BEFORE ids so a nest or document
 * whose id happens to match a segment name cannot collide with one.
 */
export const keys = {
  nests: ["nests"] as const,
  nestList: () => [...keys.nests, "list"] as const,
  unsynced: () => [...keys.nests, "unsynced"] as const,
  nest: (nestId: string) => [...keys.nests, "detail", nestId] as const,

  settings: (nestId: string) => [...keys.nest(nestId), "settings"] as const,
  nodes: (nestId: string) => [...keys.nest(nestId), "nodes"] as const,
  stewards: (nestId: string) => [...keys.nest(nestId), "stewards"] as const,
  collaborators: (nestId: string) =>
    [...keys.nest(nestId), "collaborators"] as const,
  definitions: (nestId: string) => [...keys.nest(nestId), "definitions"] as const,
  commentCounts: (nestId: string) =>
    [...keys.nest(nestId), "comment-counts"] as const,
  overview: (nestId: string) => [...keys.nest(nestId), "overview"] as const,
  graph: (nestId: string) => [...keys.nest(nestId), "graph"] as const,
  edgeTypes: (nestId: string) => [...keys.nest(nestId), "edge-types"] as const,
  edges: (nestId: string) => [...keys.nest(nestId), "edges"] as const,
  schedules: (nestId: string) => [...keys.nest(nestId), "schedules"] as const,
  env: (nestId: string) => [...keys.nest(nestId), "env"] as const,
  connectors: (nestId: string) => [...keys.nest(nestId), "connectors"] as const,
  nestTeams: (nestId: string) => [...keys.nest(nestId), "teams"] as const,
  externalEdits: (nestId: string) =>
    [...keys.nest(nestId), "external-edits"] as const,
  hooks: (nestId: string, agent?: string) =>
    [...keys.nest(nestId), "hooks", agent ?? "all"] as const,
  reviewQueue: (nestId: string, status: string) =>
    [...keys.nest(nestId), "review-queue", status] as const,
  deletionRequests: (nestId: string, status: string) =>
    [...keys.nest(nestId), "deletion-requests", status] as const,
  feed: (nestId: string, filter: string, limit: number, offset: number) =>
    [...keys.nest(nestId), "feed", filter, limit, offset] as const,

  node: (nestId: string, nodeId: string) =>
    [...keys.nodes(nestId), "node", nodeId] as const,
  nodeVersions: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "versions"] as const,
  nodeReviews: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "reviews"] as const,
  nodeStewards: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "stewards"] as const,
  nodeWatchers: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "watchers"] as const,
  nodeAnnotations: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "annotations"] as const,
  nodePendingEdit: (nestId: string, nodeId: string) =>
    [...keys.node(nestId, nodeId), "external-edit"] as const,
  nodeComments: (nestId: string, nodeId: string, status: string) =>
    [...keys.node(nestId, nodeId), "comments", status] as const,
  nodeActivity: (nestId: string, nodeId: string, limit: number) =>
    [...keys.node(nestId, nodeId), "activity", limit] as const,

  teams: ["teams"] as const,
  teamList: () => [...keys.teams, "list"] as const,
  team: (teamId: string) => [...keys.teams, "detail", teamId] as const,
  promptowlTeams: () => [...keys.teams, "promptowl"] as const,

  admin: ["admin"] as const,
  adminSettings: () => [...keys.admin, "settings"] as const,
  superAdmins: () => [...keys.admin, "super-admins"] as const,

  auth: ["auth"] as const,
  teammates: () => [...keys.auth, "teammates"] as const,
  apiKeys: () => [...keys.auth, "keys"] as const,

  license: ["license"] as const,
  licenseStatus: () => [...keys.license, "status"] as const,

  me: ["me"] as const,
  myWork: (limit?: number, offset?: number) =>
    [...keys.me, "work", limit ?? null, offset ?? null] as const,
  myDrafts: (limit?: number, offset?: number) =>
    [...keys.me, "drafts", limit ?? null, offset ?? null] as const,

  health: ["health"] as const,
};

/**
 * How long each kind of read stays fresh, in ms. One global number would be
 * wrong in both directions — a reviewer must never act on a stale queue, while
 * the nest list barely changes between sessions.
 */
const STALE = {
  /** Structure and configuration the user rarely changes mid-session. */
  reference: 5 * 60_000,
  /** Listings that churn as documents are created, renamed and retagged. */
  listing: 30_000,
  /** Governance and activity. Stale here means acting on a decision already made. */
  governance: 5_000,
  /** Document bodies always revalidate — an edit must start from server truth. */
  content: 0,
} as const;

/**
 * A 401/403/404 is an answer, not a blip: the session is gone, the caller lacks
 * permission, or the thing does not exist. Retrying cannot change any of those,
 * and retrying a 401 delays the redirect to login.
 */
function retryTransientOnly(failureCount: number, error: unknown): boolean {
  const status = (error as api.ApiError | undefined)?.status;
  if (status === 401 || status === 403 || status === 404) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryTransientOnly,
        // Drop entries five minutes after the last screen stops watching them,
        // so a long session browsing many documents does not grow without
        // bound. Anything still mounted is never collected.
        gcTime: 5 * 60_000,
        retryOnMount: true,
      },
    },
  });
}

/**
 * What a write to a nest sub-resource actually changes.
 *
 * Without this every nest write invalidated the whole nest subtree, so editing
 * one document's tags re-fetched its stewards, connectors, schedules and env —
 * NestView reads nine things at once, and all nine went stale together.
 *
 * Each entry is matched against the path AFTER `/nests/{id}`. Order matters:
 * the first match wins, so put the specific paths above the general ones.
 * Anything unmatched falls through to invalidating the whole nest, which keeps
 * a newly added endpoint correct-but-wasteful rather than silently stale.
 */
const NEST_WRITE_SCOPES: Array<{
  match: RegExp;
  /** `m` is this pattern's own match, so `m[1]` is its captured node id.
   *  Node ids contain slashes ("nodes/getting-started"), so the id can only be
   *  read from the pattern that knows where it ends. */
  affects: (
    nestId: string,
    m: RegExpMatchArray,
  ) => Array<readonly unknown[]>;
}> = [
  // Discussion. Comment counts drive the document list's sort, and both show
  // up in the activity feed.
  {
    match: /^\/nodes\/(.+)\/(?:comments|annotations)(?:\/|$)/,
    affects: (n, m) => [
      keys.node(n, m[1]),
      keys.commentCounts(n),
      [...keys.nest(n), "feed"],
    ],
  },
  // Who gets notified about a document — nothing else reads it.
  {
    match: /^\/nodes\/(.+)\/watchers(?:\/|$|\?)/,
    affects: (n, m) => [keys.nodeWatchers(n, m[1])],
  },
  // Governance verdicts. These move a document between queues, write a new
  // version, and land in both the feed and the actor's own inbox.
  {
    match:
      /^\/nodes\/(.+)\/(?:approve|reject|submit-review|revert|external-edits)(?:\/|$)/,
    affects: (n, m) => [
      keys.node(n, m[1]),
      keys.nodes(n),
      [...keys.nest(n), "review-queue"],
      keys.externalEdits(n),
      [...keys.nest(n), "feed"],
      keys.me,
    ],
  },
  {
    match: /^\/nodes\/(.+)\/request-deletion(?:\/|$)/,
    affects: (n) => [[...keys.nest(n), "deletion-requests"], keys.me],
  },
  // A move changes the document's id, so both the old and new parents are
  // covered by dropping the whole listing rather than one entry.
  {
    match: /^\/nodes\/(.+)\/move(?:\/|$)/,
    affects: (n, m) => [
      keys.node(n, m[1]),
      keys.nodes(n),
      keys.nestList(),
      [...keys.nest(n), "feed"],
    ],
  },
  // Create — no id in the path.
  {
    match: /^\/nodes(?:\/)?$/,
    affects: (n) => [keys.nodes(n), keys.nestList(), [...keys.nest(n), "feed"]],
  },
  // Any other write to one document: its body, the listing it appears in, and
  // the nest row's document_count / updated_at that the Dashboard totals use.
  {
    match: /^\/nodes\/(.+)$/,
    affects: (n, m) => [
      keys.node(n, m[1]),
      keys.nodes(n),
      keys.nestList(),
      [...keys.nest(n), "feed"],
    ],
  },
  // Roles change what the caller may see, so the nest's own permission payload
  // goes with them.
  {
    match: /^\/stewards/,
    affects: (n) => [keys.stewards(n), keys.nest(n)],
  },
  {
    match: /^\/collaborators/,
    affects: (n) => [keys.collaborators(n), keys.nest(n)],
  },
  { match: /^\/teams/, affects: (n) => [keys.nestTeams(n), keys.teams] },
  { match: /^\/settings/, affects: (n) => [keys.settings(n)] },
  { match: /^\/visibility/, affects: (n) => [keys.nest(n), keys.nestList()] },
  { match: /^\/definitions/, affects: (n) => [keys.definitions(n)] },
  { match: /^\/edges/, affects: (n) => [keys.edges(n), keys.graph(n)] },
  { match: /^\/edge-types/, affects: (n) => [keys.edgeTypes(n), keys.edges(n)] },
  { match: /^\/env/, affects: (n) => [keys.env(n)] },
  { match: /^\/hooks/, affects: (n) => [[...keys.nest(n), "hooks"]] },
  { match: /^\/schedules/, affects: (n) => [keys.schedules(n)] },
  { match: /^\/connectors/, affects: (n) => [keys.connectors(n)] },
  {
    match: /^\/external-edits/,
    affects: (n) => [keys.externalEdits(n), keys.nodes(n)],
  },
  {
    match: /^\/deletion-requests/,
    affects: (n) => [
      [...keys.nest(n), "deletion-requests"],
      keys.nodes(n),
      keys.nestList(),
      keys.me,
    ],
  },
  {
    match: /^\/(delete-folder|request-deletion)/,
    affects: (n) => [keys.nodes(n), keys.nestList()],
  },
];

/**
 * Which cached reads a mutation to `path` could have changed.
 *
 * Derived from the request path rather than registered per endpoint, so a new
 * write is covered the day it is added instead of the day someone remembers it.
 * Where the path is not recognised it errs broad: over-invalidating costs one
 * refetch, while missing an entry leaves the user looking at a value the server
 * no longer holds.
 */
export function invalidateForPath(qc: QueryClient, path: string): void {
  const drop = (queryKey: readonly unknown[]) =>
    void qc.invalidateQueries({ queryKey });

  const nest = path.match(/^\/nests\/([^/?]+)/)?.[1];
  if (nest && nest !== "import" && nest !== "unsynced") {
    const rest = path.slice(`/nests/${nest}`.length).split("?")[0];
    for (const scope of NEST_WRITE_SCOPES) {
      const m = rest.match(scope.match);
      if (!m) continue;
      for (const key of scope.affects(nest, m)) drop(key);
      return;
    }
    // Unrecognised write (including PATCH/DELETE of the nest itself): assume
    // it touched everything under this nest.
    drop(keys.nest(nest));
    drop(keys.nestList());
    return;
  }
  if (path.startsWith("/nests")) {
    // Create, import, or sync-a-folder — the list itself, and the candidate
    // folders that a sync consumes.
    drop(keys.nestList());
    drop(keys.unsynced());
    return;
  }
  if (path.startsWith("/teams")) {
    drop(keys.teams);
    // Membership changes move people in and out of nest-level grants.
    drop(keys.nests);
    return;
  }
  if (path.startsWith("/admin")) {
    drop(keys.admin);
    drop(keys.auth);
    return;
  }
  if (path.startsWith("/auth")) {
    drop(keys.auth);
    return;
  }
  if (path.startsWith("/license")) {
    drop(keys.license);
    return;
  }
  if (path.startsWith("/me")) {
    drop(keys.me);
  }
}

/**
 * Point the api module's invalidation hooks at this client, so every mutation
 * invalidates the reads it affects without any call site knowing this layer
 * exists. Called by the app shell at startup, and by tests that need the same
 * wiring without mounting React.
 */
export function connectReadCache(qc: QueryClient): void {
  api.registerReadCache({
    // Identity change: remove outright rather than mark stale. Permission
    // filtering means the previous user's response is not merely old, it is
    // theirs — it must never paint, not even for the moment before a
    // background refetch would replace it.
    clear: () => qc.clear(),
    invalidatePath: (path) => invalidateForPath(qc, path),
  });
}

/**
 * One definition per read, shared by both ways of consuming it.
 *
 * A screen that renders a single list uses the `use*` hook and re-renders when
 * a background refresh changes the data. A screen that fans out many reads at
 * once — NestView loads nine in one `Promise.all`, each with its own error
 * fallback — passes the same options object to `queryClient.fetchQuery` and
 * keeps its structure. Both hit the same cache, keys and invalidation; only the
 * subscription differs.
 *
 * Deliberately absent: search (results must match the query exactly), exports
 * and artifact HTML (not JSON reads), device-auth polling, run state, and the
 * admin-status probe — caching the identity check is the one thing a
 * per-identity cache must never do.
 */
export const reads = {
  // ── Nest-scoped ────────────────────────────────────────────────────────
  nestList: () =>
    queryOptions({
      queryKey: keys.nestList(),
      queryFn: () => api.listNests(),
      staleTime: STALE.reference,
    }),
  unsynced: () =>
    queryOptions({
      queryKey: keys.unsynced(),
      queryFn: () => api.listUnsyncedFolders(),
      staleTime: STALE.listing,
    }),
  nest: (nestId: string) =>
    queryOptions({
      queryKey: keys.nest(nestId),
      queryFn: () => api.getNest(nestId),
      staleTime: STALE.reference,
    }),
  settings: (nestId: string) =>
    queryOptions({
      queryKey: keys.settings(nestId),
      queryFn: () => api.getNestSettings(nestId),
      staleTime: STALE.reference,
    }),
  nodes: (nestId: string) =>
    queryOptions({
      queryKey: keys.nodes(nestId),
      queryFn: () => api.listNodes(nestId),
      staleTime: STALE.listing,
    }),
  stewards: (nestId: string) =>
    queryOptions({
      queryKey: keys.stewards(nestId),
      queryFn: () => api.listStewards(nestId),
      staleTime: STALE.reference,
    }),
  collaborators: (nestId: string) =>
    queryOptions({
      queryKey: keys.collaborators(nestId),
      queryFn: () => api.listCollaborators(nestId),
      staleTime: STALE.reference,
    }),
  definitions: (nestId: string) =>
    queryOptions({
      queryKey: keys.definitions(nestId),
      queryFn: () => api.listDefinitions(nestId),
      staleTime: STALE.reference,
    }),
  commentCounts: (nestId: string) =>
    queryOptions({
      queryKey: keys.commentCounts(nestId),
      queryFn: () => api.getCommentCounts(nestId),
      staleTime: STALE.listing,
    }),
  overview: (nestId: string) =>
    queryOptions({
      queryKey: keys.overview(nestId),
      queryFn: () => api.getOverview(nestId),
      staleTime: STALE.listing,
    }),
  graph: (nestId: string) =>
    queryOptions({
      queryKey: keys.graph(nestId),
      queryFn: () => api.getNestGraph(nestId),
      staleTime: STALE.listing,
    }),
  edgeTypes: (nestId: string) =>
    queryOptions({
      queryKey: keys.edgeTypes(nestId),
      queryFn: () => api.listEdgeTypes(nestId),
      staleTime: STALE.reference,
    }),
  edges: (nestId: string) =>
    queryOptions({
      queryKey: keys.edges(nestId),
      queryFn: () => api.listEdges(nestId),
      staleTime: STALE.listing,
    }),
  schedules: (nestId: string) =>
    queryOptions({
      queryKey: keys.schedules(nestId),
      queryFn: () => api.listSchedules(nestId),
      staleTime: STALE.reference,
    }),
  env: (nestId: string) =>
    queryOptions({
      queryKey: keys.env(nestId),
      queryFn: () => api.listEnv(nestId),
      staleTime: STALE.reference,
    }),
  connectors: (nestId: string) =>
    queryOptions({
      queryKey: keys.connectors(nestId),
      queryFn: () => api.listConnectors(nestId),
      staleTime: STALE.reference,
    }),
  nestTeams: (nestId: string) =>
    queryOptions({
      queryKey: keys.nestTeams(nestId),
      queryFn: () => api.listNestTeams(nestId),
      staleTime: STALE.reference,
    }),
  hooks: (nestId: string, agent?: string) =>
    queryOptions({
      queryKey: keys.hooks(nestId, agent),
      queryFn: () => api.listHooks(nestId, agent),
      staleTime: STALE.reference,
    }),
  externalEdits: (nestId: string) =>
    queryOptions({
      queryKey: keys.externalEdits(nestId),
      queryFn: () => api.listExternalEdits(nestId),
      staleTime: STALE.governance,
    }),
  reviewQueue: (nestId: string, status = "pending") =>
    queryOptions({
      queryKey: keys.reviewQueue(nestId, status),
      queryFn: () => api.getReviewQueue(nestId, status),
      staleTime: STALE.governance,
    }),
  deletionRequests: (nestId: string, status = "pending") =>
    queryOptions({
      queryKey: keys.deletionRequests(nestId, status),
      queryFn: () => api.getDeletionRequests(nestId, status),
      staleTime: STALE.governance,
    }),
  feed: (
    nestId: string,
    filter: api.FeedFilter = "all",
    limit = 50,
    offset = 0,
  ) =>
    queryOptions({
      queryKey: keys.feed(nestId, filter, limit, offset),
      queryFn: () => api.getNestFeed(nestId, filter, limit, offset),
      staleTime: STALE.governance,
    }),

  // ── Document-scoped ────────────────────────────────────────────────────
  node: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.node(nestId, nodeId),
      queryFn: () => api.getNode(nestId, nodeId),
      staleTime: STALE.content,
      // Bodies are the heaviest thing cached, and a document the user has
      // navigated away from is rarely the next one they open. Let them go early.
      gcTime: 60_000,
    }),
  nodeVersions: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodeVersions(nestId, nodeId),
      queryFn: () => api.getNodeVersions(nestId, nodeId),
      staleTime: STALE.listing,
    }),
  nodeReviews: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodeReviews(nestId, nodeId),
      queryFn: () => api.getNodeReviews(nestId, nodeId),
      staleTime: STALE.governance,
    }),
  nodeStewards: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodeStewards(nestId, nodeId),
      queryFn: () => api.getNodeStewards(nestId, nodeId),
      staleTime: STALE.reference,
    }),
  nodeWatchers: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodeWatchers(nestId, nodeId),
      queryFn: () => api.listNodeWatchers(nestId, nodeId),
      staleTime: STALE.reference,
    }),
  nodeAnnotations: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodeAnnotations(nestId, nodeId),
      queryFn: () => api.listAnnotations(nestId, nodeId),
      staleTime: STALE.governance,
    }),
  nodePendingEdit: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: keys.nodePendingEdit(nestId, nodeId),
      queryFn: () => api.getNodePendingExternalEdit(nestId, nodeId),
      staleTime: STALE.governance,
    }),
  nodeComments: (
    nestId: string,
    nodeId: string,
    status?: "open" | "resolved",
  ) =>
    queryOptions({
      queryKey: keys.nodeComments(nestId, nodeId, status ?? "all"),
      queryFn: () => api.getNodeComments(nestId, nodeId, status),
      staleTime: STALE.governance,
    }),
  nodeActivity: (nestId: string, nodeId: string, limit = 100) =>
    queryOptions({
      queryKey: keys.nodeActivity(nestId, nodeId, limit),
      queryFn: () => api.getNodeActivity(nestId, nodeId, limit),
      staleTime: STALE.governance,
    }),

  // ── Server-wide ────────────────────────────────────────────────────────
  health: () =>
    queryOptions({
      queryKey: keys.health,
      queryFn: () => api.getHealth(),
      staleTime: STALE.reference,
    }),
  adminSettings: () =>
    queryOptions({
      queryKey: keys.adminSettings(),
      queryFn: () => api.getAdminSettings(),
      staleTime: STALE.reference,
    }),
  superAdmins: () =>
    queryOptions({
      queryKey: keys.superAdmins(),
      queryFn: () => api.listSuperAdmins(),
      staleTime: STALE.reference,
    }),
  teammates: () =>
    queryOptions({
      queryKey: keys.teammates(),
      queryFn: () => api.listTeammates(),
      staleTime: STALE.reference,
    }),
  apiKeys: () =>
    queryOptions({
      queryKey: keys.apiKeys(),
      queryFn: () => api.listApiKeys(),
      staleTime: STALE.reference,
    }),
  licenseStatus: () =>
    queryOptions({
      queryKey: keys.licenseStatus(),
      queryFn: () => api.getLicenseStatus(),
      staleTime: STALE.reference,
    }),
  teamList: () =>
    queryOptions({
      queryKey: keys.teamList(),
      queryFn: () => api.listTeams(),
      staleTime: STALE.reference,
    }),
  team: (teamId: string) =>
    queryOptions({
      queryKey: keys.team(teamId),
      queryFn: () => api.getTeam(teamId),
      staleTime: STALE.reference,
    }),
  promptowlTeams: () =>
    queryOptions({
      queryKey: keys.promptowlTeams(),
      queryFn: () => api.listPromptowlTeams(),
      staleTime: STALE.reference,
    }),
  myWork: (opts?: { limit?: number; offset?: number }) =>
    queryOptions({
      queryKey: keys.myWork(opts?.limit, opts?.offset),
      queryFn: () => api.getMyWork(opts),
      staleTime: STALE.governance,
    }),
  myDrafts: (opts?: { limit?: number; offset?: number }) =>
    queryOptions({
      queryKey: keys.myDrafts(opts?.limit, opts?.offset),
      queryFn: () => api.getMyDrafts(opts),
      staleTime: STALE.governance,
    }),
};

// ── Hooks for screens that render one read and want it to update in place ──

export const useNests = () => useQuery(reads.nestList());
export const useNodes = (nestId: string | undefined) =>
  useQuery({ ...reads.nodes(nestId ?? ""), enabled: !!nestId });
export const useCollaborators = (nestId: string | undefined) =>
  useQuery({ ...reads.collaborators(nestId ?? ""), enabled: !!nestId });
export const useTeams = () => useQuery(reads.teamList());
export const useTeam = (teamId: string | undefined) =>
  useQuery({ ...reads.team(teamId ?? ""), enabled: !!teamId });
export const useAdminSettings = () => useQuery(reads.adminSettings());
export const useTeammates = () => useQuery(reads.teammates());
export const useApiKeys = () => useQuery(reads.apiKeys());
export const useNestTeams = (nestId: string | undefined) =>
  useQuery({ ...reads.nestTeams(nestId ?? ""), enabled: !!nestId });
export const useDefinitions = (nestId: string | undefined) =>
  useQuery({ ...reads.definitions(nestId ?? ""), enabled: !!nestId });

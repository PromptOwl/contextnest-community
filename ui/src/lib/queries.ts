/**
 * Shared client-side read cache.
 *
 * Every screen used to fetch on mount into its own state and throw it away on
 * unmount, so bouncing between a nest and a document re-fetched the listing
 * each time and showed a spinner for data the user had just seen. These hooks
 * put all of those reads behind one cache: a revisit paints immediately from
 * memory and revalidates in the background, and two components asking for the
 * same thing at once produce one request.
 *
 * Reads live here; the api module keeps owning the wire format and mutations.
 */

import {
  QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import * as api from "./api";

/**
 * Query keys, shaped as a hierarchy so invalidation can name either one entry
 * or a whole family. Anything under a nest is prefixed by `detail(nestId)`, so
 * invalidating that prefix drops the nest's nodes, stewards, settings and
 * review queue in one call — while a sibling nest is untouched.
 *
 * The literal segments ("detail", "nodes", …) sit BEFORE the ids so a nest or
 * document whose id happens to match a segment name cannot collide with one.
 */
export const nestKeys = {
  all: ["nests"] as const,
  list: () => [...nestKeys.all, "list"] as const,
  detail: (nestId: string) => [...nestKeys.all, "detail", nestId] as const,
  settings: (nestId: string) => [...nestKeys.detail(nestId), "settings"] as const,
  nodes: (nestId: string) => [...nestKeys.detail(nestId), "nodes"] as const,
  node: (nestId: string, nodeId: string) =>
    [...nestKeys.nodes(nestId), "node", nodeId] as const,
  stewards: (nestId: string) => [...nestKeys.detail(nestId), "stewards"] as const,
  collaborators: (nestId: string) =>
    [...nestKeys.detail(nestId), "collaborators"] as const,
  reviewQueue: (nestId: string, status: string) =>
    [...nestKeys.detail(nestId), "review-queue", status] as const,
};

/**
 * How long each kind of read stays fresh, in ms. One global number would be
 * wrong in both directions — a reviewer must never act on a stale queue, while
 * the nest list barely changes between sessions.
 */
const STALE = {
  /** Structure the user rarely changes mid-session. */
  reference: 5 * 60_000,
  /** Document listing: churns as documents are created and renamed. */
  listing: 30_000,
  /** Governance state. A stale queue means acting on a decision already made. */
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

/**
 * Point the api module's invalidation hooks at this client, so every mutation
 * that already invalidated the previous hand-rolled cache invalidates this one
 * — no mutation call site changes. Called by the app shell at startup, and by
 * tests that need the same wiring without mounting React.
 */
export function connectReadCache(qc: QueryClient): void {
  api.registerReadCache({
    // Identity change: remove outright rather than mark stale. Permission
    // filtering means the previous user's response is not merely old, it is
    // theirs — it must never paint, not even for the moment before a
    // background refetch would replace it.
    clear: () => qc.clear(),
    invalidateNest: (nestId) => {
      // Prefix match: one call covers the nest's nodes, stewards, settings and
      // review queue without naming each.
      void qc.invalidateQueries({ queryKey: nestKeys.detail(nestId) });
      void qc.invalidateQueries({ queryKey: nestKeys.list() });
    },
    invalidateList: () => {
      void qc.invalidateQueries({ queryKey: nestKeys.list() });
    },
  });
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
        // A failed fetch must not be left behind as if it were data.
        retryOnMount: true,
      },
    },
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
 */
export const nestQueries = {
  list: () =>
    queryOptions({
      queryKey: nestKeys.list(),
      queryFn: () => api.listNests(),
      staleTime: STALE.reference,
    }),
  detail: (nestId: string) =>
    queryOptions({
      queryKey: nestKeys.detail(nestId),
      queryFn: () => api.getNest(nestId),
      staleTime: STALE.reference,
    }),
  settings: (nestId: string) =>
    queryOptions({
      queryKey: nestKeys.settings(nestId),
      queryFn: () => api.getNestSettings(nestId),
      staleTime: STALE.reference,
    }),
  nodes: (nestId: string) =>
    queryOptions({
      queryKey: nestKeys.nodes(nestId),
      queryFn: () => api.listNodes(nestId),
      staleTime: STALE.listing,
    }),
  node: (nestId: string, nodeId: string) =>
    queryOptions({
      queryKey: nestKeys.node(nestId, nodeId),
      queryFn: () => api.getNode(nestId, nodeId),
      staleTime: STALE.content,
      // Bodies are the heaviest thing cached, and a document the user has
      // navigated away from is rarely the next one they open. Let them go early.
      gcTime: 60_000,
    }),
  stewards: (nestId: string) =>
    queryOptions({
      queryKey: nestKeys.stewards(nestId),
      queryFn: () => api.listStewards(nestId),
      staleTime: STALE.reference,
    }),
  collaborators: (nestId: string) =>
    queryOptions({
      queryKey: nestKeys.collaborators(nestId),
      queryFn: () => api.listCollaborators(nestId),
      staleTime: STALE.reference,
    }),
  reviewQueue: (nestId: string, status = "pending") =>
    queryOptions({
      queryKey: nestKeys.reviewQueue(nestId, status),
      queryFn: () => api.getReviewQueue(nestId, status),
      staleTime: STALE.governance,
    }),
};

export function useNests() {
  return useQuery(nestQueries.list());
}

export function useCollaborators(nestId: string | undefined) {
  return useQuery({ ...nestQueries.collaborators(nestId ?? ""), enabled: !!nestId });
}

export function useNodes(nestId: string | undefined) {
  return useQuery({ ...nestQueries.nodes(nestId ?? ""), enabled: !!nestId });
}

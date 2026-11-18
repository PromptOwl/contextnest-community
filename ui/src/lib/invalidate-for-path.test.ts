/**
 * Which cached reads a write drops.
 *
 * The mapping is derived from the request path rather than registered per
 * endpoint, so the risk is not that an entry is missing — it is that an entry
 * matches and names too little. A write that half-invalidates is worse than one
 * that is not recognised at all, because the unrecognised case errs broad and a
 * narrow match silently returns before the fallback can.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  invalidateForPath,
  keys,
  resetVerdictDrops,
  VERDICT_REFETCH_WINDOW_MS,
} from "./queries";

/** Records the keys a call to invalidateForPath would drop. */
function recorder() {
  const dropped: string[] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      dropped.push(JSON.stringify(queryKey));
    },
  } as any;
  return {
    qc,
    /** True when `key` — or a prefix of it — was invalidated. */
    drops(key: readonly unknown[]) {
      const want = JSON.stringify(key);
      return dropped.some((d) => want.startsWith(d.slice(0, -1)));
    },
  };
}

const NEST = "nest-1";

describe("invalidateForPath — nest sharing", () => {
  // A share grant puts someone on `listNestPeople`, so it changes who can be
  // mentioned. No /grants scope matches, so this rides the deliberate broad
  // fallback (drop everything under the nest) rather than a rule of its own —
  // pinned here because the invariant is "a grant write drops the roster", and
  // adding a narrow /grants rule later must not quietly stop honouring it.
  it("drops the mention roster when a share grant changes", () => {
    for (const path of [
      `/nests/${NEST}/grants`,
      `/nests/${NEST}/grants/g-1`,
    ]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.mentionable(NEST))).toBe(true);
    }
  });

  // The bug this pins: `people` (the @mention roster) rides on the
  // collaborators read, but sharing a nest with a team writes to /teams. That
  // scope dropped only the team keys, so a team removed from the nest kept
  // appearing under `@` until the page was reloaded.
  it("drops the collaborator roster when a team share changes", () => {
    for (const path of [
      `/nests/${NEST}/teams`,
      `/nests/${NEST}/teams/team-9`,
    ]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.collaborators(NEST)), path).toBe(true);
      expect(r.drops(keys.nestTeams(NEST)), path).toBe(true);
    }
  });

  it("drops it for the other ways someone gains or loses access too", () => {
    for (const path of [
      `/nests/${NEST}/collaborators`,
      `/nests/${NEST}/stewards`,
      // Unrecognised nest write — errs broad, covering grants.
      `/nests/${NEST}/grants/user-2`,
    ]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.collaborators(NEST)), path).toBe(true);
    }
  });
});

describe("invalidateForPath — admin settings", () => {
  // PEOPLE_SUGGEST_ALL_USERS is saved through /admin/settings and changes who
  // the add-a-person suggestions and every nest's @ roster offer — without
  // this the toggle only took effect after a reload.
  it("drops the people directory and nest rosters", () => {
    const r = recorder();
    invalidateForPath(r.qc, "/admin/settings");
    expect(r.drops(keys.peopleSuggest(""))).toBe(true);
    expect(r.drops(keys.mentionable(NEST))).toBe(true);
    expect(r.drops(keys.collaborators(NEST))).toBe(true);
  });
});

describe("invalidateForPath — document pins vs nest pins (CU-wdqcq02crw)", () => {
  // `/pin` (the dashboard nest bookmark) is a prefix of `/pins` (document
  // pins). The nest-pin rule must not swallow document-pin writes, or the
  // pinned strip keeps showing the old pins until a reload.
  it("a document-pin write drops the pins read, not just the nest list", () => {
    for (const path of [`/nests/${NEST}/pins`, `/nests/${NEST}/pins?node_id=nodes/a&scope=user`, `/nests/${NEST}/pins/order`]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.docPins(NEST))).toBe(true);
    }
  });

  it("a nest-pin write still drops only the nest list", () => {
    const r = recorder();
    invalidateForPath(r.qc, `/nests/${NEST}/pin`);
    expect(r.drops(keys.nestList())).toBe(true);
    expect(r.drops(keys.docPins(NEST))).toBe(false);
  });

  it("a document write (rename, move, delete) drops the pins read too", () => {
    const r = recorder();
    invalidateForPath(r.qc, `/nests/${NEST}/nodes/nodes/a`);
    expect(r.drops(keys.docPins(NEST))).toBe(true);
  });
});

describe("invalidateForPath — review verdicts arrive in runs", () => {
  // A reviewer clearing a queue approves one item after another. Each approval
  // dropped the same five groups of reads, so five quick approvals refetched
  // them all five times in a few seconds. The first verdict after a quiet spell
  // still drops at once (one approval must update the screen straight away);
  // the ones that follow share a single drop when the window ends.
  const QUEUE = [...keys.nest(NEST), "review-queue"];

  /** Counts how many times each key is invalidated. */
  function counter() {
    const hits = new Map<string, number>();
    const qc = {
      invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
        const k = JSON.stringify(queryKey);
        hits.set(k, (hits.get(k) ?? 0) + 1);
      },
    } as any;
    return { qc, count: (key: readonly unknown[]) => hits.get(JSON.stringify(key)) ?? 0 };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    resetVerdictDrops();
  });
  afterEach(() => {
    resetVerdictDrops();
    vi.useRealTimers();
  });

  it("drops straight away for a single approval", () => {
    const c = counter();
    invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/a/approve`);
    expect(c.count(QUEUE)).toBe(1);
  });

  it("folds a run of approvals into one extra drop at the end of the window", () => {
    const c = counter();
    for (const id of ["a", "b", "c", "d", "e"]) {
      invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/${id}/approve`);
      vi.advanceTimersByTime(200);
    }
    // The first went through at once, the other four are waiting.
    expect(c.count(QUEUE)).toBe(1);
    vi.advanceTimersByTime(VERDICT_REFETCH_WINDOW_MS);
    expect(c.count(QUEUE)).toBe(2);
    // Nothing further is pending.
    vi.advanceTimersByTime(VERDICT_REFETCH_WINDOW_MS * 4);
    expect(c.count(QUEUE)).toBe(2);
  });

  it("treats a rejection like an approval", () => {
    const c = counter();
    invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/a/reject`);
    invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/b/reject`);
    expect(c.count(QUEUE)).toBe(1);
    vi.advanceTimersByTime(VERDICT_REFETCH_WINDOW_MS);
    expect(c.count(QUEUE)).toBe(2);
  });

  it("drops at once again after a quiet spell", () => {
    const c = counter();
    invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/a/approve`);
    vi.advanceTimersByTime(VERDICT_REFETCH_WINDOW_MS + 1);
    invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/b/approve`);
    expect(c.count(QUEUE)).toBe(2);
  });

  it("does not delay other writes, including submitting for review", () => {
    const c = counter();
    for (let i = 0; i < 3; i++) {
      invalidateForPath(c.qc, `/nests/${NEST}/nodes/nodes/a/submit-review`);
    }
    expect(c.count(QUEUE)).toBe(3);
  });
});

describe("invalidateForPath — channels (PO-1189)", () => {
  const post = `/nests/${NEST}/nodes/nodes/channels/ops/annotations`;

  it("a post or reply drops the channel list (unread, activity) and My Work, not the open timeline", () => {
    for (const path of [post, `${post}/t-1/comments`, `${post}/t-1/resolve`]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.channelList(NEST))).toBe(true);
      expect(r.drops(keys.myWork())).toBe(true);
      // The page merges what is new itself; a blanket refetch would drop loaded pages.
      expect(r.drops(keys.channelTimeline(NEST, "ops"))).toBe(false);
      expect(r.drops(keys.nodes(NEST))).toBe(false);
    }
  });

  it("marking a channel read drops nothing: it is the caller's own mark, written into the list by the page", () => {
    const r = recorder();
    invalidateForPath(r.qc, `/nests/${NEST}/channels/ops/read`);
    expect(r.drops(keys.channelList(NEST))).toBe(false);
    expect(r.drops(keys.nest(NEST))).toBe(false);
  });

  it("create, archive and restore drop the channel list and the document listing", () => {
    for (const path of [`/nests/${NEST}/channels`, `/nests/${NEST}/channels/ops/archive`]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.channelList(NEST))).toBe(true);
      expect(r.drops(keys.nodes(NEST))).toBe(true);
    }
  });

  it("promoting a thread drops the document listing, where the new node appears", () => {
    const r = recorder();
    invalidateForPath(r.qc, `/nests/${NEST}/threads/t-1/promote`);
    expect(r.drops(keys.nodes(NEST))).toBe(true);
    expect(r.drops(keys.search)).toBe(true);
    expect(r.drops(keys.settings(NEST))).toBe(false);
  });

  it("a webhook change drops the webhook list and the @ picker's agent handles only", () => {
    for (const path of [`/nests/${NEST}/agent-webhooks/grok`, `/nests/${NEST}/agent-webhooks/grok/test`]) {
      const r = recorder();
      invalidateForPath(r.qc, path);
      expect(r.drops(keys.agentWebhooks(NEST))).toBe(true);
      expect(r.drops(keys.agentHandles(NEST))).toBe(true);
      expect(r.drops(keys.nodes(NEST))).toBe(false);
    }
  });

  it("marking a mention done drops My Work", () => {
    const r = recorder();
    invalidateForPath(r.qc, "/me/work/mentions/t-1/done");
    expect(r.drops(keys.myWork())).toBe(true);
  });
});

/**
 * Which cached reads a write drops.
 *
 * The mapping is derived from the request path rather than registered per
 * endpoint, so the risk is not that an entry is missing — it is that an entry
 * matches and names too little. A write that half-invalidates is worse than one
 * that is not recognised at all, because the unrecognised case errs broad and a
 * narrow match silently returns before the fallback can.
 */
import { describe, it, expect } from "vitest";
import { invalidateForPath, keys } from "./queries";

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

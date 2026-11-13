import { describe, it, expect } from "vitest";
import {
  SETUP_STEPS,
  deriveProgress,
  dryRunSummary,
  dryRunTree,
  fixOptions,
  guardView,
  nestNameForChannel,
  neverList,
  pickInstall,
  unresolved,
  willList,
  type ChannelPick,
} from "./control-room-setup";
import type { SurfacesBindingPreview, SurfacesInstallRef } from "./api";

const install = (status: SurfacesInstallRef["status"], id = "i1"): SurfacesInstallRef => ({ id, surface: "slack", mode: "manifest", status, home_nest_id: "n1" });
const preview = (over: Partial<SurfacesBindingPreview> & { detail?: Partial<SurfacesBindingPreview["guard"]["detail"]>; surface_ok?: boolean; members_known?: boolean } = {}): SurfacesBindingPreview => ({
  no_seed: false,
  would_bind: over.would_bind ?? true,
  guard: {
    capture_ok: over.would_bind ?? true,
    surface_ok: over.surface_ok ?? true,
    members_known: over.members_known ?? true,
    detail: {
      readers_total: 3,
      readers_absent: 0,
      members_total: 7,
      members_not_readers: 0,
      guests: 0,
      externals: 0,
      non_user_principals: [],
      universe: false,
      org_wide: false,
      ext_shared: false,
      ...over.detail,
    },
  },
  conversation_kind: "private_channel",
  is_ext_shared: over.is_ext_shared ?? false,
  ext_capture_enabled: over.ext_capture_enabled ?? false,
  disclosure: "This server's administrators can read every nest.",
});

describe("AC-CR-01: each step states what happens and what is never captured", () => {
  it("AC-CR-01: five steps, in order, each with a plain one-line purpose", () => {
    expect(SETUP_STEPS.map((s) => s.title)).toEqual(["Connect Slack", "Choose channels", "Check who can read", "Add starter folders", "Turn on listening"]);
    for (const s of SETUP_STEPS) expect(s.sub.length).toBeGreaterThan(10);
  });

  it("AC-CR-01: the never list names DMs between people, history, recaps, the never-propose categories and the 24 h text limit", () => {
    const never = neverList().join("\n");
    expect(never).toMatch(/DMs between people/);
    expect(never).toMatch(/channel history/);
    expect(never).toMatch(/recaps or summaries/);
    expect(never).toMatch(/pay, health, performance or personal matters/);
    expect(never).toMatch(/longer than 24 hours/);
  });

  it("AC-CR-01: the copy follows the server's settings: quiet window, text kept, DMs only while DM capture is on", () => {
    expect(willList()[0]).toBe("Listen only in channels you turn on");
    const s = { quiet_minutes: 30, buffer_ttl_hours: 12, dm_capture: true };
    expect(willList(s)[0]).toMatch(/and in DMs people start with it/);
    expect(willList(s)[1]).toBe("Wait until a thread has been quiet for 30 minutes");
    expect(neverList(s)[4]).toBe("Keep message text longer than 12 hours");
  });
});

describe("AC-CR-15: progress comes from facts, so setup resumes where it was left", () => {
  const facts = (over: Partial<Parameters<typeof deriveProgress>[0]> = {}) => ({
    install: null,
    bindings: [],
    seededNestIds: [],
    picks: [],
    checked: false,
    ...over,
  });

  it("AC-CR-15: an install with bindings but no seed lands on step 4 with steps 1–3 done, 3 of 5", () => {
    const p = deriveProgress(facts({ install: install("active"), bindings: [{ nest_id: "n1", status: "active", conversation_id: "C1" }] }));
    expect(p.done).toEqual([true, true, true, false, false]);
    expect(p.current).toBe(3);
    expect(p.count).toBe(3);
    expect(p.targetNestIds).toEqual(["n1"]);
  });

  it("AC-CR-15: nothing set up → step 1, 0 done; a pending install is not connected", () => {
    expect(deriveProgress(facts())).toMatchObject({ current: 0, count: 0 });
    expect(deriveProgress(facts({ install: install("pending") }))).toMatchObject({ current: 0, count: 0 });
  });

  it("AC-CR-15: connected with no channels → step 2; picks made but not checked → step 3", () => {
    expect(deriveProgress(facts({ install: install("active") }))).toMatchObject({ current: 1, count: 1 });
    const picks: ChannelPick[] = [{ channelId: "C1", channelName: "revops", nestId: "n1", on: true }];
    expect(deriveProgress(facts({ install: install("active"), picks }))).toMatchObject({ current: 2, count: 2 });
    expect(deriveProgress(facts({ install: install("active"), picks, checked: true }))).toMatchObject({ current: 3, count: 3 });
  });

  it("AC-CR-15: every target nest seeded but nothing bound yet → step 5; bound and seeded → all 5 done", () => {
    const picks: ChannelPick[] = [
      { channelId: "C1", channelName: "revops", nestId: "n1", on: true },
      { channelId: "C2", channelName: "eng", nestId: "n2", on: true },
      { channelId: "C3", channelName: "off", nestId: "n3", on: false },
    ];
    const half = deriveProgress(facts({ install: install("active"), picks, checked: true, seededNestIds: ["n1"] }));
    expect(half.current).toBe(3);
    expect(half.targetNestIds).toEqual(["n1", "n2"]);
    expect(deriveProgress(facts({ install: install("active"), picks, checked: true, seededNestIds: ["n1", "n2"] }))).toMatchObject({ current: 4, count: 4 });
    const all = deriveProgress(facts({ install: install("active"), bindings: [{ nest_id: "n1", status: "active", conversation_id: "C1" }], seededNestIds: ["n1"] }));
    expect(all.done).toEqual([true, true, true, true, true]);
    expect(all.count).toBe(5);
  });

  it("AC-CR-15: removed bindings don't count; an active install wins over a pending one", () => {
    expect(deriveProgress(facts({ install: install("active"), bindings: [{ nest_id: "n1", status: "removed", conversation_id: "C1" }] })).count).toBe(1);
    expect(pickInstall([install("pending", "p"), install("active", "a"), { ...install("active", "t"), surface: "teams" }])?.id).toBe("a");
    expect(pickInstall([install("disconnected", "d")])).toBeNull();
  });
});

describe("AC-CR-02: a refused pair names the counts and offers the fixes before anything is saved", () => {
  it("AC-CR-02: a refusal names readers_total and readers_absent from guard_detail, and offers create / other nest / leave off", () => {
    const v = guardView(preview({ would_bind: false, detail: { readers_total: 312, readers_absent: 306, members_total: 6 } }), { channel: "leadership", nest: "Company" });
    expect(v).toEqual({ state: "refused", label: "Can't listen here", note: "Company is readable by 312 people, and 306 of them aren't in #leadership." });
    expect(fixOptions(v)).toEqual(["create_nest", "other_nest", "leave_off"]);
  });

  it("AC-CR-02: other refusal reasons are named in plain words, with counts only", () => {
    expect(guardView(preview({ would_bind: false, members_known: false }), { channel: "x", nest: "N" }).note).toBe("We couldn't list who is in #x, so we refuse rather than guess.");
    expect(guardView(preview({ would_bind: false, detail: { universe: true } }), { channel: "x", nest: "N" }).note).toMatch(/anyone with the link/);
    expect(guardView(preview({ would_bind: false, detail: { non_user_principals: ["agent", "key"] } }), { channel: "x", nest: "N" }).note).toBe("N is also read by other agents, API keys, which aren't in #x.");
    expect(guardView(preview({ would_bind: false, detail: { org_wide: true, members_total: 1 } }), { channel: "x", nest: "N" }).note).toBe("N is readable by everyone on this server, and only 1 person is in #x.");
  });

  it("AC-CR-02: Slack Connect is off unless chosen, with listen-to-our-people-only as the fix", () => {
    const v = guardView(preview({ would_bind: false, is_ext_shared: true, detail: { externals: 4, ext_shared: true } }), { channel: "acme-shared", nest: "Revenue", orgName: "Larkspur" });
    expect(v.state).toBe("external");
    expect(v.label).toBe("Off unless you choose");
    expect(v.note).toBe("4 people here are from another organization. Turning it on listens to Larkspur people only.");
    expect(fixOptions(v)).toEqual(["ext_only", "leave_off"]);
  });

  it("AC-CR-02: allowed pairs say whether cards may quote existing records", () => {
    expect(guardView(preview(), { channel: "a", nest: "Revenue" })).toEqual({ state: "ok", label: "Cards can show existing records", note: null });
    const po = guardView(preview({ surface_ok: false, detail: { members_total: 18, members_not_readers: 11 } }), { channel: "revops", nest: "Revenue" });
    expect(po).toEqual({ state: "proposals_only", label: "Proposals only", note: "11 of the 18 members can't read Revenue, so cards here never quote existing records." });
    expect(fixOptions(po)).toEqual([]);
  });

  it("AC-CR-02: Continue stays disabled until every picked refusal is resolved (fixed, moved or left off)", () => {
    const picks: ChannelPick[] = [
      { channelId: "C1", channelName: "revops", nestId: "n1", on: true },
      { channelId: "C2", channelName: "leadership", nestId: "n2", on: true },
      { channelId: "C3", channelName: "unchecked", nestId: "n2", on: true },
    ];
    const ok = guardView(preview(), { channel: "revops", nest: "R" });
    const refused = guardView(preview({ would_bind: false }), { channel: "leadership", nest: "C" });
    expect(unresolved(picks, { C1: ok, C2: refused }).map((p) => p.channelId)).toEqual(["C2", "C3"]);
    const left = picks.map((p) => (p.channelId === "C2" ? { ...p, on: false } : p));
    expect(unresolved(left, { C1: ok, C3: ok })).toEqual([]);
  });

  it("names a new nest after the channel", () => {
    expect(nestNameForChannel("leadership")).toBe("Leadership");
    expect(nestNameForChannel("acme-renewal_team")).toBe("Acme renewal team");
  });
});

describe("AC-CR-14: the dry run shows created vs already there", () => {
  const items = [
    { kind: "folder" as const, target: "decisions/", action: "unchanged" },
    { kind: "folder" as const, target: "people/", action: "create" },
    { kind: "folder" as const, target: "customers/", action: "unchanged" },
    { kind: "folder" as const, target: "projects/", action: "create" },
    { kind: "definition" as const, target: "decision", action: "create" },
    { kind: "definition" as const, target: "owner", action: "kept_human_edit" },
    { kind: "context" as const, target: "CONTEXT.md", action: "create", title: "Context" },
    { kind: "node" as const, target: "nodes/thesis", action: "create", title: "Thesis" },
  ];

  it("AC-CR-14: each item is marked + (will be created) or = (already exists), from what dry_run returns", () => {
    const t = dryRunTree(items);
    expect(t.rows).toEqual([
      { mark: "same", label: "decisions/", note: "What we agreed, who agreed it, when" },
      { mark: "add", label: "people/", note: "Roles, ownership, how to reach someone" },
      { mark: "same", label: "customers/", note: "Terms, contacts, commitments made" },
      { mark: "add", label: "projects/", note: "Goals, owners, status, deadlines" },
      { mark: "add", label: "CONTEXT.md", note: "Explains each folder to people and agents" },
      { mark: "add", label: "1 glossary term", note: "decision" },
      { mark: "add", label: "thesis", note: "Thesis" },
    ]);
    expect(dryRunSummary(t)).toBe("2 folders, CONTEXT.md, 1 term and 1 document would be added. 2 folders already exist and stay as they are.");
  });

  it("AC-CR-14: a starter already applied says nothing would change", () => {
    const t = dryRunTree(items.map((i) => ({ ...i, action: "unchanged" })));
    expect(t.nothingToDo).toBe(true);
    expect(dryRunSummary(t)).toMatch(/already here/);
  });
});

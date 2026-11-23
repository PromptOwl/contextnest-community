import { describe, it, expect } from "vitest";
import {
  SETUP_STEPS,
  deriveProgress,
  dryRunSummary,
  dryRunTree,
  fixOptions,
  guardView,
  membersToAdd,
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

describe("noticeParagraphs: the wizard's preview matches the notice the server posts", () => {
  it("states this server's buffer TTL, not a fixed 24 hours", async () => {
    const { noticeParagraphs } = await import("./control-room-setup");
    expect(noticeParagraphs("Revenue", 12).join(" ")).toMatch(/messages are cleared within 12 hours/);
    expect(noticeParagraphs("Revenue", 24).join(" ")).toMatch(/messages are cleared within 24 hours/);
  });
});

describe("po-1432: the wizard names who blocks a pair and offers to add channel members to the nest", () => {
  type People = NonNullable<SurfacesBindingPreview["people"]>;
  const withPeople = (p: SurfacesBindingPreview, people: Partial<People>): SurfacesBindingPreview => ({
    ...p,
    people: { absent_readers: [], members_not_readers: [], universe_cause: null, ...people },
  });
  const refused = (people: Partial<People>, detail: Partial<SurfacesBindingPreview["guard"]["detail"]> = { readers_total: 7, readers_absent: 1 }) =>
    withPeople(preview({ would_bind: false, detail }), people);
  const ctx = { channel: "testnest", nest: "PO - Engineering Ops" };

  it("AC 1: a reader no Slack user is linked to is named with the email", () => {
    const v = guardView(refused({ absent_readers: [{ user_id: "u1", name: "Misha", email: "misha@promptowl.ai", reason: "no_slack_link" }] }), ctx);
    expect(v.state).toBe("refused");
    expect(v.note).toBe("1 person who can read PO - Engineering Ops can't be found in #testnest.");
    expect(v.groups).toEqual([{ heading: "No Slack user in this workspace has the same email:", people: ["Misha (misha@promptowl.ai)"] }]);
  });

  it("AC 2: readers not in the channel are named, with a message only", () => {
    const one = guardView(refused({ absent_readers: [{ user_id: "u1", name: "Sam", email: "sam@x.ai", reason: "not_in_channel" }] }), ctx);
    expect(one.groups).toEqual([{ heading: "Not in #testnest. Add them in Slack, then check again:", people: ["Sam"] }]);
    expect(fixOptions(one)).toEqual(["create_nest", "other_nest", "leave_off"]);
    const many = guardView(
      refused({
        absent_readers: [
          { user_id: "u1", name: "Sam", email: "sam@x.ai", reason: "not_in_channel" },
          { user_id: "u2", name: null, email: "taimur@x.ai", reason: "not_in_channel" },
          { user_id: "u3", name: "Qaish", email: "qaish@x.ai", reason: "not_in_channel" },
        ],
      }),
      ctx,
    );
    // A list, not one sentence per person (po-1440).
    expect(many.groups).toEqual([{ heading: "Not in #testnest. Add them in Slack, then check again:", people: ["Sam", "taimur@x.ai", "Qaish"] }]);
  });

  it("a reader without an account is named by email", () => {
    const v = guardView(refused({ absent_readers: [{ user_id: null, name: null, email: "new@x.ai", reason: "no_account" }] }), ctx);
    expect(v.groups).toEqual([{ heading: "No account on this server yet:", people: ["new@x.ai"] }]);
  });

  it("po-1440: mixed reasons give one summary and one list per reason, never a repeated sentence", () => {
    const v = guardView(
      refused(
        {
          absent_readers: [
            { user_id: "u1", name: "Sam", email: "sam@x.ai", reason: "not_in_channel" },
            { user_id: "u2", name: "Misha", email: "misha@promptowl.ai", reason: "no_slack_link" },
            { user_id: "u3", name: "Ana", email: "ana@x.ai", reason: "no_slack_link" },
            { user_id: null, name: null, email: "new@x.ai", reason: "no_account" },
          ],
        },
        { readers_total: 9, readers_absent: 4 },
      ),
      ctx,
    );
    expect(v.note).toBe("4 people who can read PO - Engineering Ops can't be found in #testnest.");
    expect(v.groups!.map((g) => g.heading)).toEqual([
      "Not in #testnest. Add them in Slack, then check again:",
      "No Slack user in this workspace has the same email:",
      "No account on this server yet:",
    ]);
    expect(v.groups![1].people).toEqual(["Misha (misha@promptowl.ai)", "Ana (ana@x.ai)"]);
  });

  it("po-1445: with a reader unmatched by email, the unmatched channel members show the email Slack has", () => {
    const v = guardView(
      refused({
        absent_readers: [{ user_id: "u2", name: "Misha", email: "misha@promptowl.ai", reason: "no_slack_link" }],
        members_not_readers: [
          { surface_user_id: "SM", name: "Misha S", community_user_id: null, email: null, slack_email: "misha@promptowl.io" },
          { surface_user_id: "SQ", name: "Quinn", community_user_id: null, email: null, slack_email: null },
          { surface_user_id: "SC", name: "Carol", community_user_id: "u-carol", email: "carol@x.ai" },
        ],
      }),
      ctx,
    );
    expect(v.groups![1]).toEqual({
      heading: "In #testnest but not matched to an account here:",
      people: ["Misha S: Slack email misha@promptowl.io", "Quinn: Slack shares no confirmed email"],
    });
    // Without an email mismatch to explain, the members aren't listed.
    const plain = guardView(refused({ absent_readers: [{ user_id: "u1", name: "Sam", email: "sam@x.ai", reason: "not_in_channel" }], members_not_readers: [{ surface_user_id: "SQ", name: "Quinn", community_user_id: null, email: null, slack_email: null }] }), ctx);
    expect(plain.groups).toHaveLength(1);
  });

  it("po-1467: a same-email member whose link was refused shows once, with the reason, not as both absent and unmatched", () => {
    const v = guardView(
      refused({
        absent_readers: [
          { user_id: "u1", name: "Hiren", email: "hiren@promptowl.ai", reason: "not_linked", match_reason: "unverified" },
          { user_id: "u2", name: null, email: "temp_a@gmail.com", reason: "no_slack_link" },
        ],
        members_not_readers: [
          { surface_user_id: "SH", name: "Hiren F", community_user_id: null, email: null, slack_email: "Hiren@promptowl.ai" },
          { surface_user_id: "SQ", name: "Quinn", community_user_id: null, email: null, slack_email: null },
        ],
      }),
      ctx,
    );
    expect(v.groups).toEqual([
      { heading: "In #testnest with the same email, but not linked to their account:", people: ["Hiren: their email here is not verified"] },
      { heading: "No Slack user in this workspace has the same email:", people: ["temp_a@gmail.com"] },
      { heading: "In #testnest but not matched to an account here:", people: ["Quinn: Slack shares no confirmed email"] },
    ]);
  });

  it("AC 6: a public nest and a live public link name their cause", () => {
    expect(guardView(refused({ universe_cause: "public" }, { universe: true }), ctx).note).toBe(
      "PO - Engineering Ops is public, so anything saved from #testnest would be readable by anyone.",
    );
    expect(guardView(refused({ universe_cause: "link" }, { universe: true }), ctx).note).toBe(
      "PO - Engineering Ops has a live public link, so anything saved from #testnest could be read by anyone with it. Revoke the link or pick another nest.",
    );
  });

  it("an older server without people keeps the counts message", () => {
    expect(guardView(preview({ would_bind: false, detail: { readers_total: 7, readers_absent: 1 } }), ctx).note).toBe(
      "PO - Engineering Ops is readable by 7 people, and 1 of them isn't in #testnest.",
    );
  });

  it("AC 3, 5: channel members who can't read the nest are offered; those without an account can't be added", () => {
    const p = withPeople(preview({ surface_ok: false, detail: { members_total: 3, members_not_readers: 2 } }), {
      members_not_readers: [
        { surface_user_id: "SC", name: "Carol", community_user_id: "u-carol", email: "carol@x.ai" },
        { surface_user_id: "SX", name: "Xavier", community_user_id: null, email: null },
      ],
    });
    expect(membersToAdd(p)).toEqual([
      { surface_user_id: "SC", name: "Carol", community_user_id: "u-carol", email: "carol@x.ai", addable: true },
      { surface_user_id: "SX", name: "Xavier", community_user_id: null, email: null, addable: false },
    ]);
    expect(membersToAdd(preview())).toEqual([]);
  });
});

describe("po-1432 review: shared-deployment cause and capped name lists", () => {
  const ctx = { channel: "testnest", nest: "PO - Engineering Ops" };
  const people = (over: Partial<NonNullable<SurfacesBindingPreview["people"]>>) => ({ absent_readers: [], members_not_readers: [], universe_cause: null, ...over });

  it("a nest visible to every organization on a shared server says so, not 'revoke the link'", () => {
    const p = { ...preview({ would_bind: false, detail: { universe: true } }), people: people({ universe_cause: "shared_deployment" }) };
    expect(guardView(p, ctx).note).toBe(
      "PO - Engineering Ops is visible to every organization on this shared server, so anything saved from #testnest would be too. Make the nest private or pick another nest.",
    );
  });

  it("when the server names fewer readers than are absent, the note gives the full count and says only the first are listed", () => {
    const p = {
      ...preview({ would_bind: false, detail: { readers_total: 312, readers_absent: 22 } }),
      people: people({ absent_readers: [{ user_id: "u1", name: "Sam", email: "sam@x.ai", reason: "not_in_channel" }] }),
    };
    expect(guardView(p, ctx).note).toBe("22 people who can read PO - Engineering Ops can't be found in #testnest. Only 1 is listed below.");
  });
});

describe("po-1448: Server settings → Surfaces helpers", () => {
  it("generateBufferKey makes 32 random bytes in base64, different every time", async () => {
    const { generateBufferKey } = await import("./control-room-setup");
    const a = generateBufferKey();
    const b = generateBufferKey();
    expect(a).toHaveLength(44);
    expect(Uint8Array.from(atob(a), (c) => c.charCodeAt(0))).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("hostedSlackUrls builds the four Slack URLs from the public base URL, and nothing without one", async () => {
    const { hostedSlackUrls } = await import("./control-room-setup");
    expect(hostedSlackUrls("https://nest.acme.com/")).toEqual({
      redirect: "https://nest.acme.com/surfaces/slack/oauth/callback",
      events: "https://nest.acme.com/surfaces/slack/hosted/events",
      interactions: "https://nest.acme.com/surfaces/slack/hosted/interactions",
      commands: "https://nest.acme.com/surfaces/slack/hosted/commands",
    });
    expect(hostedSlackUrls("")).toBeNull();
    expect(hostedSlackUrls(null)).toBeNull();
  });
});

describe("po-1446: channel activity in plain words", () => {
  const base = { days: 7, since: "", received: 0, buffered: 0, skipped: {}, waiting: 0, judged: { proposed: 0, nothing_kept: 0, failed: 0 }, cards: { posted: 0, queued: 0, held: 0 } };

  it("names what arrived, what was skipped and why, what is waiting, what was judged, and the cards", async () => {
    const { activityLines } = await import("./control-room-setup");
    const lines = activityLines(
      { ...base, received: 14, buffered: 9, skipped: { too_short: 3, bot_or_system: 2 }, waiting: 1, judged: { proposed: 1, nothing_kept: 4, failed: 0 }, cards: { posted: 1, queued: 1, held: 0 } },
      20,
    );
    expect(lines).toEqual([
      "14 messages received · 9 kept for judging · 5 skipped (3 too short, 2 from bots or Slack itself)",
      "1 thread waiting for the 20-minute quiet window",
      "5 threads judged: 1 proposed, 4 with nothing worth keeping. The Decision ledger says why for each.",
      "1 card posted · 1 queued for tomorrow (daily limit)",
    ]);
  });

  it("says where to look when nothing arrived", async () => {
    const { activityLines } = await import("./control-room-setup");
    const lines = activityLines(base, 20);
    expect(lines).toContain("No thread judged yet.");
    expect(lines[lines.length - 1]).toMatch(/Nothing arrived/);
  });
});

describe("po-1446 review: failed, held and singular wording", () => {
  it("says failed and held, and uses the singular for one", async () => {
    const { activityLines } = await import("./control-room-setup");
    const lines = activityLines(
      { days: 7, since: "", received: 1, buffered: 1, skipped: {}, waiting: 0, judged: { proposed: 0, nothing_kept: 0, failed: 1 }, cards: { posted: 0, queued: 0, held: 1 } },
      20,
    );
    expect(lines[0]).toBe("1 message received · 1 kept for judging · 0 skipped");
    expect(lines[1]).toBe("1 thread judged: 0 proposed, 0 with nothing worth keeping, 1 failed. The Decision ledger says why for each.");
    expect(lines[2]).toBe("0 cards posted · 1 held (no eligible reviewer in the channel)");
  });
});

/**
 * Control room → Setup (po-1186 CR3): the logic behind the five-step Slack
 * setup, kept free of React so each acceptance criterion is a unit test.
 *
 * Where the wizard is comes from facts the server already holds (the install,
 * the bindings, the seeds applied) plus what the admin has picked in this
 * visit. Nothing about the wizard is stored. Every sentence it shows is plain
 * words over counts the guard returns; no names but the channel and nest the
 * admin picked themselves.
 */
import type {
  SurfacesBinding,
  SurfacesBindingActivity,
  SurfacesBindingPreview,
  SurfacesInstallRef,
  SurfacesSeedItem,
  SurfacesSettingsView,
} from "./api";

export const SETUP_STEPS = [
  { title: "Connect Slack", sub: "Install the app in your workspace" },
  { title: "Choose channels", sub: "Pick where it may listen" },
  { title: "Check who can read", sub: "Make sure saved notes stay in the room" },
  { title: "Add starter folders", sub: "Give it somewhere to put things" },
  { title: "Turn on listening", sub: "Post one notice, then stay quiet" },
] as const;

export type SettingsCopy = Pick<SurfacesSettingsView, "quiet_minutes" | "buffer_ttl_hours" | "dm_capture"> &
  Partial<Pick<SurfacesSettingsView, "reviewer_daily_cards" | "conversation_daily_cards">>;

export const DEFAULT_SETTINGS_COPY: Required<SettingsCopy> = {
  quiet_minutes: 20,
  buffer_ttl_hours: 24,
  dm_capture: false,
  reviewer_daily_cards: 2,
  conversation_daily_cards: 3,
};

/** "It will": what Nest does, from the server's own settings. */
export function willList(s: SettingsCopy = DEFAULT_SETTINGS_COPY): string[] {
  return [
    s.dm_capture ? "Listen only in channels you turn on, and in DMs people start with it" : "Listen only in channels you turn on",
    `Wait until a thread has been quiet for ${s.quiet_minutes} minutes`,
    "Ask one named reviewer before anything is saved",
    "Save only what that person approves, under their name",
  ];
}

/** "It will never": the same list the public member page shows. */
export function neverList(s: SettingsCopy = DEFAULT_SETTINGS_COPY): string[] {
  return [
    "Read DMs between people, or channels it isn't in",
    "Import channel history",
    "Post recaps or summaries in the channel",
    "Propose pay, health, performance or personal matters",
    `Keep message text longer than ${s.buffer_ttl_hours} hours`,
  ];
}

// ─── Where the wizard is ───────────────────────────────────────────────────

/** The admin's choice for one channel, made in this visit. */
export interface ChannelPick {
  channelId: string;
  channelName: string;
  nestId: string;
  on: boolean;
  /** Slack Connect: listen to our own people only (ext_capture_enabled). */
  extCapture?: boolean;
}

export interface SetupFacts {
  install: SurfacesInstallRef | null;
  /** Bindings on that install that are live or paused (not removed). */
  bindings: Pick<SurfacesBinding, "nest_id" | "status" | "conversation_id">[];
  /** Nests that have at least one seed applied. */
  seededNestIds: readonly string[];
  picks: readonly ChannelPick[];
  /** Step 3 passed in this visit: every picked channel can listen. */
  checked: boolean;
}

export interface SetupProgress {
  done: [boolean, boolean, boolean, boolean, boolean];
  /** The step to open: the first one not done (the last when all are). */
  current: number;
  count: number;
  /** Nests the starter must be applied to: bound nests and picked nests. */
  targetNestIds: string[];
}

/**
 * The Slack install setup is about: an active one first, else a pending one
 * of the mode setup is in now. A pending hosted install has no manifest.
 */
export function pickInstall(installs: readonly SurfacesInstallRef[], hosted: boolean): SurfacesInstallRef | null {
  const slack = installs.filter((i) => i.surface === "slack");
  return slack.find((i) => i.status === "active") ?? slack.find((i) => i.status === "pending" && (i.mode === "hosted") === hosted) ?? null;
}

export function deriveProgress(f: SetupFacts): SetupProgress {
  const connected = f.install?.status === "active";
  const live = f.bindings.filter((b) => b.status !== "removed");
  const bound = connected && live.length > 0;
  const picked = f.picks.filter((p) => p.on);
  const chose = connected && (bound || picked.length > 0);
  const checked = connected && (bound || (picked.length > 0 && f.checked));
  const targetNestIds = [...new Set([...live.map((b) => b.nest_id), ...picked.map((p) => p.nestId)])];
  const seeded = new Set(f.seededNestIds);
  const starter = checked && targetNestIds.length > 0 && targetNestIds.every((n) => seeded.has(n));
  const listening = bound && starter;
  const done: SetupProgress["done"] = [connected, chose, checked, starter, listening];
  const first = done.findIndex((d) => !d);
  return { done, current: first === -1 ? SETUP_STEPS.length - 1 : first, count: done.filter(Boolean).length, targetNestIds };
}

// ─── The guard, in plain words ─────────────────────────────────────────────

export type GuardState = "ok" | "proposals_only" | "refused" | "external";

export interface GuardView {
  state: GuardState;
  /** The headline shown with the status dot. */
  label: string;
  /** One sentence with the counts, or null. */
  note: string | null;
  /** Why the pair passed, in plain words (step 3). */
  passed?: string[];
  /** po-1432: channel members who can't read the nest (the "Add to nest" popup). */
  add?: MemberToAdd[];
  /** po-1440: who blocks the pair, one list per reason, under the short note. */
  groups?: PeopleGroup[];
}

export interface PeopleGroup {
  heading: string;
  people: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const NON_USER: Record<string, string> = {
  key: "API keys",
  agent: "other agents",
  connector: "outbound connectors",
  support: "support access",
  anon: "anonymous readers",
};

type AbsentReader = NonNullable<SurfacesBindingPreview["people"]>["absent_readers"][number];

type Member = NonNullable<SurfacesBindingPreview["people"]>["members_not_readers"][number];

/**
 * po-1432 / po-1440: who blocks the pair, one list per reason, so the warning
 * reads as a summary plus names instead of one sentence per person. When a
 * reader has no Slack match, the unmatched channel members are listed with the
 * email Slack has (po-1445), so a .com/.io mismatch shows at a glance.
 */
/** po-1467: why the identity rules refused a same-email link, in plain words. */
const MATCH_REASON: Record<string, string> = {
  unverified: "their email here is not verified",
  domain: "their email domain is not on this server's sign-in list",
  org_domain: "this server hosts several organizations, and their email domain is not on this Slack connection's list. Add it under Email domains",
  no_match: "no account here has the email Slack has for them",
  no_profile: "Slack did not return their profile. Check again in a minute",
  ambiguous: "their account is already linked to another Slack user, or more than one account has this email",
  email_unconfirmed: "Slack has not confirmed their email",
  home_team: "their Slack user is from another workspace",
  not_a_member: "their Slack user is a guest or deactivated",
  blocked: "automatic matching is turned off for their Slack user",
};

function absentGroups(absent: AbsentReader[], members: Member[], ch: string): PeopleGroup[] {
  const groups: PeopleGroup[] = [];
  const add = (heading: string, people: string[]) => people.length && groups.push({ heading, people });
  add(
    `Not in ${ch}. Add them in Slack, then check again:`,
    absent.filter((r) => r.reason === "not_in_channel").map((r) => r.name ?? r.email ?? "Someone"),
  );
  const notLinked = absent.filter((r) => r.reason === "not_linked");
  add(
    `In ${ch} with the same email, but not linked to their account:`,
    notLinked.map((r) => `${r.name ?? r.email ?? "Someone"}: ${r.match_reason ? (MATCH_REASON[r.match_reason] ?? `the link could not be made (${r.match_reason})`) : "they match now. Check again"}`),
  );
  // Those members are explained above; don't list them again as unmatched.
  const linkedEmails = new Set(notLinked.map((r) => (r.email ?? "").toLowerCase()));
  members = members.filter((m) => !m.slack_email || !linkedEmails.has(m.slack_email.toLowerCase()));
  const noLink = absent.filter((r) => r.reason === "no_slack_link");
  add(
    "No Slack user in this workspace has the same email:",
    noLink.map((r) => (r.name ? `${r.name} (${r.email})` : (r.email ?? "Someone"))),
  );
  if (noLink.length) {
    add(
      `In ${ch} but not matched to an account here:`,
      members
        .filter((m) => !m.community_user_id && !m.is_bot)
        .map((m) => `${m.name ?? m.surface_user_id}: ${m.slack_email ? `Slack email ${m.slack_email}` : "Slack shares no confirmed email"}`),
    );
  }
  add(
    "No account on this server yet:",
    absent.filter((r) => r.reason === "no_account").map((r) => r.email ?? "Someone"),
  );
  return groups;
}

/** po-1432: name the channel members who can't read the nest, so a hidden "Add to nest" is explained. */
function memberGroups(members: Member[]): { groups?: PeopleGroup[] } {
  const label = (m: Member) => m.name ?? m.surface_user_id;
  const groups = [
    { heading: "Can be added to the nest:", people: members.filter((m) => m.community_user_id).map((m) => (m.email ? `${label(m)} (${m.email})` : label(m))) },
    {
      heading: "No matching account on this server, so they can't be added:",
      people: members.filter((m) => !m.community_user_id && !m.is_bot).map((m) => (m.slack_email ? `${label(m)}: Slack email ${m.slack_email}` : label(m))),
    },
    { heading: "Apps in the channel. They can't be given access; remove them in Slack:", people: members.filter((m) => m.is_bot).map(label) },
  ].filter((g) => g.people.length);
  return groups.length ? { groups } : {};
}

export type MemberToAdd =NonNullable<SurfacesBindingPreview["people"]>["members_not_readers"][number] & { addable: boolean };

/** po-1432: channel members who can't read the nest; only those with an account can be added. */
export function membersToAdd(p: SurfacesBindingPreview): MemberToAdd[] {
  return (p.people?.members_not_readers ?? []).map((m) => ({ ...m, addable: !!m.community_user_id }));
}

/**
 * What the binding preview means for one channel → nest pair. Counts only,
 * straight from guard.detail; the only names are the channel and nest the
 * admin picked.
 */
export function guardView(p: SurfacesBindingPreview, ctx: { channel: string; nest: string; orgName?: string | null }): GuardView {
  const d = p.guard.detail;
  const ch = `#${ctx.channel}`;
  if (p.is_ext_shared && !p.ext_capture_enabled) {
    const people = ctx.orgName ? `${ctx.orgName} people` : "your own people";
    return {
      state: "external",
      label: "Off unless you choose",
      note: `${d.externals > 0 ? `${plural(d.externals, "person", "people")} here ${d.externals === 1 ? "is" : "are"} from another organization. ` : "This channel is shared with another organization. "}Turning it on listens to ${people} only.`,
    };
  }
  if (!p.would_bind) {
    let note: string;
    let groups: PeopleGroup[] | undefined;
    const absent = p.people?.absent_readers ?? [];
    const cause = p.people?.universe_cause;
    if (!p.guard.members_known) note = `We couldn't list who is in ${ch}, so we refuse rather than guess.`;
    else if (d.universe && cause === "public") note = `${ctx.nest} is public, so anything saved from ${ch} would be readable by anyone.`;
    else if (d.universe && cause === "link") {
      note = `${ctx.nest} has a live public link, so anything saved from ${ch} could be read by anyone with it. Revoke the link or pick another nest.`;
    } else if (d.universe && cause === "shared_deployment") {
      note = `${ctx.nest} is visible to every organization on this shared server, so anything saved from ${ch} would be too. Make the nest private or pick another nest.`;
    } else if (d.universe) note = `${ctx.nest} can be read by anyone with the link, so anything saved from ${ch} would be public.`;
    else if (d.non_user_principals.length) {
      note = `${ctx.nest} is also read by ${d.non_user_principals.map((k) => NON_USER[k] ?? k).join(", ")}, which aren't in ${ch}.`;
    } else if (d.org_wide) note = `${ctx.nest} is readable by everyone on this server, and only ${plural(d.members_total, "person", "people")} ${d.members_total === 1 ? "is" : "are"} in ${ch}.`;
    else if (absent.length) {
      // The server names at most 20; the counts say how many there are in all.
      const total = Math.max(d.readers_absent, absent.length);
      note = `${plural(total, "person", "people")} who can read ${ctx.nest} can't be found in ${ch}.${total > absent.length ? ` Only ${absent.length} ${absent.length === 1 ? "is" : "are"} listed below.` : ""}`;
      groups = absentGroups(absent, p.people?.members_not_readers ?? [], ch);
    }
    else note = `${ctx.nest} is readable by ${plural(d.readers_total, "person", "people")}, and ${d.readers_absent} of them ${d.readers_absent === 1 ? "isn't" : "aren't"} in ${ch}.`;
    return { state: "refused", label: "Can't listen here", note, ...(groups ? { groups } : {}) };
  }
  const passed = [
    d.readers_absent === 0
      ? d.readers_total === 1
        ? `The 1 person who can read ${ctx.nest} is in ${ch}, so nobody outside the channel sees what it saves.`
        : `All ${d.readers_total} people who can read ${ctx.nest} are in ${ch}, so nobody outside the channel sees what it saves.`
      : `${ch} is a public channel chosen on purpose, so its notes may be read by everyone who can read ${ctx.nest}.`,
    p.guard.surface_ok
      ? `All ${plural(d.members_total, "channel member")} can read ${ctx.nest}, so cards in Slack can show its existing notes.`
      : `${d.members_not_readers} of the ${plural(d.members_total, "channel member")} can't read ${ctx.nest}. They see new suggestions in Slack, never existing notes.`,
    "Server admins can read every nest and aren't counted.",
  ];
  if (!p.guard.surface_ok) {
    const n = d.members_not_readers;
    return {
      passed,
      state: "proposals_only",
      label: "Proposals only",
      note:
        n > 0
          ? `${n} of the ${plural(d.members_total, "member")} can't read ${ctx.nest}, so cards here never quote existing records.`
          : `Some people here can't read ${ctx.nest}, so cards here never quote existing records.`,
      ...memberGroups(p.people?.members_not_readers ?? []),
    };
  }
  return { state: "ok", label: "Cards can show existing records", note: null, passed };
}

export type FixOption = "create_nest" | "other_nest" | "leave_off" | "ext_only";

/** The ways out of a refusal, offered before anything is saved (AC-CR-02). */
export function fixOptions(v: GuardView): FixOption[] {
  if (v.state === "refused") return ["create_nest", "other_nest", "leave_off"];
  if (v.state === "external") return ["ext_only", "leave_off"];
  return [];
}

/** Picked channels that still can't listen. Continue stays off until this is 0. */
export function unresolved(picks: readonly ChannelPick[], views: Record<string, GuardView | undefined>): ChannelPick[] {
  return picks.filter((p) => {
    if (!p.on) return false;
    const v = views[p.channelId];
    return !v || v.state === "refused" || v.state === "external";
  });
}

/** A nest name for "Create a nest for these people": the channel, in words. */
export function nestNameForChannel(channel: string): string {
  const words = channel.replace(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "New nest";
}

// ─── Server settings → Surfaces (po-1448) ─────────────────────────────────

/** A fresh buffer key: 32 random bytes, base64 (what `openssl rand -base64 32` gives). Made in the browser; sent only on Save. */
export function generateBufferKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}


/** What the hosted Slack app must ask for. Same lists as the server's manifest (BOT_SCOPES, BOT_EVENTS). */
export const SLACK_BOT_SCOPES: readonly string[] = [
  "channels:history",
  "groups:history",
  "im:history",
  "channels:read",
  "groups:read",
  "im:read",
  "im:write",
  "reactions:read",
  "users:read",
  "users:read.email",
  "chat:write",
  "app_mentions:read",
  "commands",
];
export const SLACK_BOT_EVENTS: readonly string[] = [
  "message.channels",
  "message.groups",
  "message.im",
  "app_mention",
  "reaction_added",
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_shared",
  "channel_unshared",
  "channel_archive",
  "group_archive",
  "channel_deleted",
  "group_deleted",
  "user_change",
  "app_home_opened",
  "app_uninstalled",
  "tokens_revoked",
];

// ─── Channel activity (po-1446) ────────────────────────────────────────────

/** Why the gate skipped a message, in plain words. Unknown codes are de-snake-cased. */
const SKIP_TEXT: Record<string, string> = {
  too_short: "too short",
  bot_or_system: "from bots or Slack itself",
  external_or_guest: "from guests or other organizations",
  opted_out: "from people who said skip me",
  duplicate: "duplicates",
  paused: "sent while paused",
  not_enabled: "sent before listening was on",
  ask_requester: "🧠 asks from guests or people who said skip me",
  buffer_error: "not stored (server error)",
};

/** The activity counts as a few plain sentences, in the order a tester asks them. */
export function activityLines(a: SurfacesBindingActivity, quietMinutes: number): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const skipped = Object.entries(a.skipped).filter(([, v]) => v > 0);
  const dropped = skipped.reduce((s, [, v]) => s + v, 0);
  const lines = [
    `${n(a.received, "message")} received · ${a.buffered} kept for judging · ${dropped} skipped` +
      (skipped.length ? ` (${skipped.map(([k, v]) => `${v} ${SKIP_TEXT[k] ?? k.replace(/_/g, " ")}`).join(", ")})` : ""),
  ];
  if (a.waiting) lines.push(`${n(a.waiting, "thread")} waiting for the ${quietMinutes}-minute quiet window`);
  const j = a.judged;
  const total = j.proposed + j.nothing_kept + j.failed;
  lines.push(
    total
      ? `${n(total, "thread")} judged: ${j.proposed} proposed, ${j.nothing_kept} with nothing worth keeping${j.failed ? `, ${j.failed} failed` : ""}. The Decision ledger says why for each.`
      : "No thread judged yet.",
  );
  const c = a.cards;
  lines.push(`${n(c.posted, "card")} posted${c.queued ? ` · ${c.queued} queued for tomorrow (daily limit)` : ""}${c.held ? ` · ${c.held} held (no eligible reviewer in the channel)` : ""}`);
  // A missing buffer key shows as skipped messages, so nothing at all means Slack's events don't get here.
  if (!a.received)
    lines.push(
      "Nothing arrived from Slack. At api.slack.com/apps → your app → Event Subscriptions, check that the Request URL is the events address listed under Setup → Slack app and is verified, and that the bot events include message.channels (public channels), message.groups (private channels), app_mention (mentions) and reaction_added (🧠), then reinstall the app. Also check that the app is in this channel and its signing secret is the one saved under Slack app.",
    );
  return lines;
}

// ─── The starter dry run ───────────────────────────────────────────────────

/** Plain descriptions for the bundled generic-team folders. */
export const FOLDER_NOTES: Record<string, string> = {
  "decisions/": "What we agreed, who agreed it, when",
  "people/": "Roles, ownership, how to reach someone",
  "projects/": "Goals, owners, status, deadlines",
  "customers/": "Terms, contacts, commitments made",
  "how-we-work/": "Processes and team norms",
  "agents/": "Saved agents. Only nest admins approve here",
};

export type TreeMark = "add" | "same";

export interface TreeRow {
  mark: TreeMark;
  label: string;
  note: string | null;
}

const ADDS = new Set(["create", "created", "update", "updated"]);

export interface DryRunTree {
  rows: TreeRow[];
  foldersAdded: number;
  foldersExisting: number;
  termsAdded: number;
  contextAdded: boolean;
  documentsAdded: number;
  /** Nothing would be written. */
  nothingToDo: boolean;
}

/** The dry run as a tree: created vs already there (AC-CR-14). */
export function dryRunTree(items: readonly SurfacesSeedItem[]): DryRunTree {
  const rows: TreeRow[] = [];
  const folders = items.filter((i) => i.kind === "folder");
  for (const f of folders) rows.push({ mark: ADDS.has(f.action) ? "add" : "same", label: f.target, note: FOLDER_NOTES[f.target] ?? null });
  const ctx = items.find((i) => i.kind === "context");
  if (ctx) rows.push({ mark: ADDS.has(ctx.action) ? "add" : "same", label: "CONTEXT.md", note: "Explains each folder to people and agents" });
  const defs = items.filter((i) => i.kind === "definition");
  const defsAdded = defs.filter((d) => ADDS.has(d.action));
  if (defs.length) {
    const shown = defsAdded.length ? defsAdded : defs;
    rows.push({
      mark: defsAdded.length ? "add" : "same",
      label: `${shown.length} glossary ${shown.length === 1 ? "term" : "terms"}`,
      note: shown.map((d) => d.target).join(", "),
    });
  }
  const docs = items.filter((i) => i.kind === "node");
  for (const n of docs) rows.push({ mark: ADDS.has(n.action) ? "add" : "same", label: n.target.replace(/^nodes\//, ""), note: n.title ?? null });
  const foldersAdded = folders.filter((f) => ADDS.has(f.action)).length;
  const documentsAdded = docs.filter((n) => ADDS.has(n.action)).length;
  const contextAdded = !!ctx && ADDS.has(ctx.action);
  return {
    rows,
    foldersAdded,
    foldersExisting: folders.length - foldersAdded,
    termsAdded: defsAdded.length,
    contextAdded,
    documentsAdded,
    nothingToDo: foldersAdded + documentsAdded + defsAdded.length + (contextAdded ? 1 : 0) === 0,
  };
}

/** "Dry run, nothing written. 4 folders, CONTEXT.md and 4 terms would be added. 2 folders already exist…" */
export function dryRunSummary(t: DryRunTree): string {
  if (t.nothingToDo) return "Everything in this starter is already here. Applying it again changes nothing.";
  const parts: string[] = [];
  if (t.foldersAdded) parts.push(plural(t.foldersAdded, "folder"));
  if (t.contextAdded) parts.push("CONTEXT.md");
  if (t.termsAdded) parts.push(plural(t.termsAdded, "term"));
  if (t.documentsAdded) parts.push(plural(t.documentsAdded, "document"));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const existing = t.foldersExisting
    ? ` ${plural(t.foldersExisting, "folder")} already ${t.foldersExisting === 1 ? "exists and stays as it is" : "exist and stay as they are"}.`
    : "";
  return `${list} would be added.${existing}`;
}

// ─── The one notice ────────────────────────────────────────────────────────

/**
 * What the bot posts once in each channel, as the server writes it
 * (src/surfaces/services/notice-service.ts enableNotice). Shown before
 * "Turn on" so the admin sees the exact words.
 */
/** The wizard's preview of the enable notice; `ttlHours` is this server's buffer_ttl_hours, as in the posted notice. */
export function noticeParagraphs(nest: string, ttlHours: number): string[] {
  return [
    `Your Slack app is now listening here for ${nest}. It stays quiet unless something looks worth keeping, and then proposes it for a named person to approve.`,
    `What it keeps: only summaries a named person approves; messages are cleared within ${ttlHours} hours.`,
    "React 🧠 to a message to ask Nest to keep it. Mention the app and say \"skip me\" and it won't use your messages. This server's administrators can read every nest.",
  ];
}

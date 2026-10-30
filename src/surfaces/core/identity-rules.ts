/**
 * Identity rules (§4.11), pure: the six auto-match conditions, the
 * interaction checks, and the first-use confirm prompt.
 */
import type { Surface, SurfaceUserProfile } from "../contract.js";

export type AutoMatchReason =
  | "no_profile"
  | "home_team"
  | "not_a_member"
  | "email_unconfirmed"
  | "no_match"
  | "ambiguous"
  | "unverified"
  | "domain"
  | "blocked";

export type AutoMatchVerdict = { ok: true; userId: string } | { ok: false; reason: AutoMatchReason };

export interface AutoMatchCandidate {
  id: string;
  email: string;
  email_verified: boolean;
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).trim().toLowerCase() : null;
}

/**
 * All six must hold (§4.11):
 * (1) same home team (and enterprise) as the install;
 * (2) not a bot / deleted / restricted / ultra-restricted / stranger / Teams guest;
 * (3) the surface vouches for the email (Slack is_email_confirmed === true);
 * (4) exactly one Community user in the owning org has it (case-insensitive), verified;
 * (5) its domain is a verified domain, when any are configured;
 * (6) the pair isn't auto_match_blocked.
 *
 * `candidates` = Community users in the owning org whose email equals the
 * profile email case-insensitively (the caller filters by org).
 */
export function autoMatchVerdict(input: {
  profile: SurfaceUserProfile | null;
  install: { surface: Surface; home_team_id: string | null; enterprise_id: string | null };
  candidates: AutoMatchCandidate[];
  verifiedDomains: string[];
  blocked: boolean;
}): AutoMatchVerdict {
  const p = input.profile;
  if (input.blocked) return { ok: false, reason: "blocked" };
  if (!p) return { ok: false, reason: "no_profile" };
  if (!p.home_team_id || p.home_team_id !== input.install.home_team_id) return { ok: false, reason: "home_team" };
  if ((input.install.enterprise_id ?? null) !== (p.enterprise_id ?? null)) return { ok: false, reason: "home_team" };
  if (p.is_bot || p.deleted || p.is_restricted || p.is_ultra_restricted || p.is_stranger) return { ok: false, reason: "not_a_member" };
  if ((p.user_role ?? "").toLowerCase() === "guest") return { ok: false, reason: "not_a_member" };
  if (p.email_confirmed !== true || !p.email) return { ok: false, reason: "email_unconfirmed" };
  const email = p.email.trim().toLowerCase();
  const matches = input.candidates.filter((c) => c.email.trim().toLowerCase() === email);
  if (matches.length === 0) return { ok: false, reason: "no_match" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  if (!matches[0].email_verified) return { ok: false, reason: "unverified" };
  const domains = input.verifiedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (domains.length > 0) {
    const d = domainOf(email);
    if (!d || !domains.includes(d)) return { ok: false, reason: "domain" };
  }
  return { ok: true, userId: matches[0].id };
}

export type InteractionVerdict = { ok: true } | { ok: false; message: string };

/**
 * A surface interaction (button click, modal submit) must come from the
 * binding's own team/enterprise/channel, and the clicker's home team must be
 * the install's (§4.11 "Interaction checks", AC-IDN-15).
 */
export function checkInteraction(
  payload: { team_id: string | null; enterprise_id: string | null; channel_id: string | null; clicker_home_team: string | null },
  expected: { team_id: string | null; enterprise_id: string | null; channel_id: string; install_home_team: string | null; org_name?: string },
): InteractionVerdict {
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);
  const ok =
    same(payload.team_id, expected.team_id) &&
    same(payload.enterprise_id, expected.enterprise_id) &&
    same(payload.channel_id, expected.channel_id) &&
    !!payload.clicker_home_team &&
    same(payload.clicker_home_team, expected.install_home_team);
  return ok ? { ok: true } : { ok: false, message: `Only ${expected.org_name ?? "this workspace's"} members can act on this.` };
}

/** Commit-class actions that need the first-use confirm (§4.11). */
export const COMMIT_VERBS = ["approve", "edit", "reject", "approve_selected", "update_record", "keep_record"] as const;
export type CommitVerb = (typeof COMMIT_VERBS)[number];

const VERB_WORDS: Record<CommitVerb, string> = {
  approve: "approve",
  edit: "edit",
  reject: "reject",
  approve_selected: "approve the selected items of",
  update_record: "update the record from",
  keep_record: "keep the record over",
};

export function firstUsePrompt(verb: CommitVerb, identity: { name: string | null; email: string }): string {
  const who = identity.name ? `${identity.name} (${identity.email})` : identity.email;
  return `You're about to **${VERB_WORDS[verb]}** this, recorded under ${who}. Is that you?`;
}

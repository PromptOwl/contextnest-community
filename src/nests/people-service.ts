/**
 * Nest people — who can reach a nest, by any of the paths resolveNestAccess
 * honours. Its own module rather than part of sharing-service: the mention
 * notifier needs it, and sharing-service sits on the teams-service →
 * notify-service import chain.
 */
import { getDb } from "../db/client.js";
import {
  parseSharedTeams,
  listSharedTeamMembers,
} from "../governance/teams-service.js";

/** Someone who can reach a nest, and the path that lets them. */
export interface NestPerson {
  email: string;
  name: string | null;
  /** Highest-precedence path this person has in: owner beats grant. */
  source: "owner" | "collaborator" | "team" | "steward" | "grant";
  /** Their user id, or null for a steward invited by email who never signed up. */
  userId: string | null;
}

// Precedence, lowest wins. Also the rank column of the union query below —
// ordering the query IS the precedence rule, so the dedupe just keeps firsts.
const PERSON_SOURCES: NestPerson["source"][] = [
  "owner", // 0
  "collaborator", // 1
  "team", // 2 — not in the union; team rosters are JSON on the team row
  "steward", // 3
  "grant", // 4
];

/**
 * Everyone who can reach a nest — the union of the five access paths
 * `resolveNestAccess` honours. The collaborator roster alone answers only one
 * of them, so the @mention picker (and anything else asking "who is on this
 * nest") would silently miss the owner, a shared team, a steward and a grant
 * holder. Deduped by email, highest-precedence source kept.
 *
 * Four of the five paths are ordinary tables, so they resolve in ONE union
 * query rather than a query apiece. Shared teams can't join in — a team's
 * roster is a JSON array on the team row, and the JSON operators differ
 * between SQLite and Postgres — so they cost the nest read (which runs
 * alongside the union) plus one lookup, and only when teams are actually
 * shared onto the nest.
 */
export async function listNestPeople(nestId: string): Promise<NestPerson[]> {
  const db = getDb();
  const [nest, rows] = await Promise.all([
    db.get("SELECT shared_teams FROM nests WHERE id = ?", [nestId]) as Promise<
      { shared_teams: string | null } | undefined
    >,
    db.all(
      `SELECT 0 AS rank, u.id AS user_id, u.email AS email, u.name AS name
         FROM nests n JOIN users u ON u.id = n.user_id
        WHERE n.id = ?
       UNION ALL
       SELECT 1, u.id, u.email, u.name
         FROM nest_collaborators nc JOIN users u ON u.id = nc.user_id
        WHERE nc.nest_id = ?
       UNION ALL
       SELECT 3, u.id, s.user_email, u.name
         FROM stewards s
         LEFT JOIN users u ON LOWER(u.email) = LOWER(s.user_email)
        WHERE s.nest_id = ? AND s.is_active = 1
       UNION ALL
       SELECT 4, u.id, u.email, u.name
         FROM grants g JOIN users u ON u.id = g.user_id
        WHERE g.nest_id = ?
       ORDER BY rank`,
      [nestId, nestId, nestId, nestId],
    ) as Promise<Array<{ rank: number; user_id: string | null; email: string; name: string | null }>>,
  ]);
  if (!nest) return [];

  const teamRefs = parseSharedTeams(nest.shared_teams);
  const teamRows = teamRefs.length
    ? (await listSharedTeamMembers(teamRefs)).map((m) => ({
        rank: 2,
        user_id: m.userId,
        email: m.email,
        name: m.name,
      }))
    : [];

  const people: NestPerson[] = [];
  const seen = new Set<string>();
  // Stable sort by rank so a person on several paths keeps their strongest.
  for (const row of [...rows, ...teamRows].sort((a, b) => a.rank - b.rank)) {
    const email = (row.email || "").trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    people.push({
      email,
      name: row.name ?? null,
      userId: row.user_id ?? null,
      source: PERSON_SOURCES[row.rank],
    });
  }
  return people;
}

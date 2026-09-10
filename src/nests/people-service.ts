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
  listTeamsForUser,
} from "../governance/teams-service.js";
import { isServerAdminUserId } from "../shared/access.js";
import { ANON_USER_ID } from "../shared/constants.js";

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

/** Someone the caller could plausibly add, and why they're suggested. */
export interface PersonSuggestion {
  email: string;
  name: string | null;
  /** How the caller already knows them: a shared nest, a shared team, or —
   *  for a server admin, who can see everyone — the server directory. */
  source: "nest" | "team" | "directory";
}

const SUGGEST_LIMIT = 20;

/** Most rows the query fetches before the merge narrows them to `cap`. Bounds
 *  the server-admin case, where the candidate set is every account. */
const SUGGEST_FETCH = 200;

/** Does this person match what the user has typed so far? Applied to the team
 *  rosters, which are JSON and so can't be filtered in SQL. */
function matchesQuery(
  person: { email: string; name: string | null },
  q: string,
): boolean {
  if (!q) return true;
  return (
    person.email.toLowerCase().includes(q) ||
    (person.name || "").toLowerCase().includes(q)
  );
}

/**
 * `AND (email LIKE … OR name LIKE …)` for the typed query, plus its two
 * arguments — so a query narrows in the database rather than by loading every
 * candidate and filtering in memory. `%` and `_` in what the user typed are
 * literal characters, not wildcards, hence the escape.
 */
function queryFilter(q: string): { sql: string; args: string[] } {
  if (!q) return { sql: "", args: [] };
  const pattern = `%${q.replace(/([\\%_])/g, "\\$1")}%`;
  return {
    sql:
      " AND (LOWER(u.email) LIKE ? ESCAPE '\\'" +
      " OR LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '\\')",
    args: [pattern, pattern],
  };
}

/**
 * People the caller can be offered when adding someone — the directory the
 * add-a-person controls autocomplete against.
 *
 * Deliberately NOT every user on the server: that list is `/auth/teammates`,
 * which is server-admin only precisely because a full member roster is not
 * public. What a plain caller may see is who they ALREADY work with — anyone
 * on a nest they own or collaborate on (its owner, collaborators and active
 * stewards) and anyone on a team they own or belong to. A server admin manages
 * the deployment's accounts, so for them the directory is every user.
 *
 * Suggestions are a convenience, never an authority: the caller can still type
 * an address that appears nowhere here (that's how you invite someone who has
 * no account yet), and the add itself re-checks permission and the escalation
 * cap server-side.
 */
export async function suggestPeopleForUser(
  callerUserId: string,
  query = "",
  limit = SUGGEST_LIMIT,
): Promise<PersonSuggestion[]> {
  const db = getDb();
  const q = query.trim().toLowerCase();
  const cap = Math.min(Math.max(limit, 1), SUGGEST_LIMIT);

  const caller = (await db.get("SELECT email FROM users WHERE id = ?", [
    callerUserId,
  ])) as { email?: string } | undefined;
  const callerEmail = (caller?.email || "").toLowerCase();
  const filter = queryFilter(q);

  const rows = (await (async () => {
    if (await isServerAdminUserId(callerUserId)) {
      return (await db.all(
        `SELECT u.id AS user_id, u.email AS email, u.name AS name, 'directory' AS source
           FROM users u
          WHERE u.id != ? AND u.id != ?${filter.sql}
          ORDER BY u.email
          LIMIT ?`,
        [callerUserId, ANON_USER_ID, ...filter.args, SUGGEST_FETCH],
      )) as SuggestionRow[];
    }
    // The nests the caller can reach as owner or collaborator. Reused three
    // times below, so it stays a subquery rather than three round trips —
    // `IN (SELECT … UNION SELECT …)` is portable across SQLite and Postgres.
    const myNests = `SELECT id FROM nests WHERE user_id = ?
                     UNION SELECT nest_id FROM nest_collaborators WHERE user_id = ?`;
    return (await db.all(
      `SELECT u.id AS user_id, u.email AS email, u.name AS name, 'nest' AS source
         FROM users u
        WHERE u.id != ? AND u.id != ?
          AND (u.id IN (SELECT user_id FROM nests WHERE id IN (${myNests}))
               OR u.id IN (SELECT user_id FROM nest_collaborators
                            WHERE nest_id IN (${myNests}))
               OR LOWER(u.email) IN (SELECT LOWER(user_email) FROM stewards
                                      WHERE is_active = 1
                                        AND nest_id IN (${myNests})))${filter.sql}
        ORDER BY u.email
        LIMIT ?`,
      [
        callerUserId,
        ANON_USER_ID,
        callerUserId,
        callerUserId,
        callerUserId,
        callerUserId,
        callerUserId,
        callerUserId,
        ...filter.args,
        SUGGEST_FETCH,
      ],
    )) as SuggestionRow[];
  })()) as SuggestionRow[];

  const byEmail = new Map<string, PersonSuggestion>();
  const add = (
    email: string | null | undefined,
    name: string | null,
    source: PersonSuggestion["source"],
  ) => {
    const addr = (email || "").trim();
    const key = addr.toLowerCase();
    if (!addr || !key || key === callerEmail || byEmail.has(key)) return;
    const person = { email: addr, name: name ?? null, source };
    if (!matchesQuery(person, q)) return;
    byEmail.set(key, person);
  };

  for (const r of rows) add(r.email, r.name, r.source);

  // Teams can't join in: a roster is a JSON array on the team row. One read of
  // the caller's own teams covers every team path (owned or joined). A stored
  // roster carries no display name, so the names come from one users lookup
  // rather than a query per member — the picker shows a person, not an address.
  const teamEmails = new Set<string>();
  for (const team of await listTeamsForUser(callerUserId)) {
    for (const member of team.members ?? []) {
      const key = (member.email || "").trim().toLowerCase();
      if (key && key !== callerEmail && !byEmail.has(key)) teamEmails.add(key);
    }
  }
  if (teamEmails.size > 0) {
    const list = [...teamEmails];
    const named = (await db.all(
      `SELECT email, name FROM users
        WHERE LOWER(email) IN (${list.map(() => "?").join(",")})`,
      list,
    )) as Array<{ email: string; name: string | null }>;
    const nameOf = new Map(
      named.map((u) => [u.email.toLowerCase(), u.name ?? null]),
    );
    for (const email of list) add(email, nameOf.get(email) ?? null, "team");
  }

  // Alphabetical by the label the picker shows — a stable order matters more
  // than relevance ranking at this size, and the caller is typing to narrow.
  return [...byEmail.values()]
    .sort((a, b) =>
      (a.name || a.email).localeCompare(b.name || b.email, undefined, {
        sensitivity: "base",
      }),
    )
    .slice(0, cap);
}

interface SuggestionRow {
  user_id: string | null;
  email: string;
  name: string | null;
  source: PersonSuggestion["source"];
}

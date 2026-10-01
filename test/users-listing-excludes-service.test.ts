/**
 * Guard against a new user LIST query that forgets access-key identities
 * (CU-wdqcq0314u). Any `FROM users` read in src/ must either address one
 * account (by id or email) or filter `is_service` — otherwise a headless
 * access key's identity shows up as a person in whatever it lists.
 *
 * A static scan, like scripts/check-mcp-schemas.mjs: crude on purpose, and
 * the allowlist below names each known exception with its reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// Queries that read more than one account but can't include a service
// identity, or must see them.
const ALLOWED = [
  "src/db/migrations.ts", // schema maintenance — must see every row
  "src/db/migrations.postgres.ts",
  // Members of the caller's own nests — a service identity is never a member.
  "src/nests/people-service.ts:'nest' AS source",
];

describe("user list queries exclude access-key identities", () => {
  it("every FROM users read is single-account or filters is_service", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8");
      const re = /FROM users\b([\s\S]{0,400}?)(`|"\s*[,)]|'\s*[,)])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const tail = m[1];
        const single = /WHERE\s+(u\.)?id\s*(=|IN)|WHERE\s+(LOWER\()?\s*(u\.)?email\)?\s*=|WHERE\s+lower\((u\.)?email\)\s*=|WHERE\s+LOWER\((u\.)?email\)\s*(=|IN)/i.test(tail);
        const filtered = /is_service/.test(tail);
        if (single || filtered) continue;
        const line = text.slice(0, m.index).split("\n").length;
        const where = `${file.replace(/\\/g, "/")}:${line}`;
        const context = text.slice(Math.max(0, m.index - 600), m.index);
        const allowed = ALLOWED.some((a) => {
          const [f, hint] = a.split(":");
          return where.startsWith(f) && (!hint || context.includes(hint) || tail.includes(hint));
        });
        if (!allowed) offenders.push(`${where}  FROM users${tail.slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

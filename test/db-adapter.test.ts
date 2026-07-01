import { describe, it, expect } from "vitest";
import { translatePlaceholders } from "../src/db/adapter.postgres.js";
import { nowExpr, insertOrIgnore, insertOrReplace } from "../src/db/sql.js";
import type { DatabaseAdapter } from "../src/db/adapter.js";

// Minimal fake adapters — the dialect helpers only read `.dialect`.
const sqlite = { dialect: "sqlite" } as DatabaseAdapter;
const postgres = { dialect: "postgres" } as DatabaseAdapter;

describe("translatePlaceholders (?→$n)", () => {
  it("numbers placeholders left to right", () => {
    expect(
      translatePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
    ).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
  });

  it("leaves a placeholder-free statement untouched", () => {
    expect(translatePlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("does NOT touch a ? inside a single-quoted string literal", () => {
    // The literal '%?%' must be preserved; only the real placeholder becomes $1.
    expect(
      translatePlaceholders("SELECT * FROM t WHERE x LIKE '%?%' AND y = ?"),
    ).toBe("SELECT * FROM t WHERE x LIKE '%?%' AND y = $1");
  });

  it("handles many placeholders", () => {
    expect(translatePlaceholders("VALUES (?, ?, ?, ?, ?)")).toBe(
      "VALUES ($1, $2, $3, $4, $5)",
    );
  });
});

describe("nowExpr", () => {
  it("uses datetime('now') on SQLite", () => {
    expect(nowExpr(sqlite)).toBe("datetime('now')");
  });
  it("uses a UTC to_char form on Postgres matching SQLite's text format", () => {
    expect(nowExpr(postgres)).toContain("to_char");
    expect(nowExpr(postgres)).toContain("YYYY-MM-DD HH24:MI:SS");
  });
});

describe("insertOrIgnore", () => {
  const base = "INSERT INTO t (a, b) VALUES (?, ?)";
  it("rewrites to INSERT OR IGNORE on SQLite", () => {
    expect(insertOrIgnore(sqlite, base)).toBe(
      "INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)",
    );
  });
  it("appends ON CONFLICT DO NOTHING on Postgres", () => {
    expect(insertOrIgnore(postgres, base)).toBe(
      "INSERT INTO t (a, b) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );
  });
});

describe("insertOrReplace", () => {
  const base = "INSERT INTO t (id, v) VALUES (?, ?)";
  it("rewrites to INSERT OR REPLACE on SQLite", () => {
    expect(insertOrReplace(sqlite, base, ["id"], "v = excluded.v")).toBe(
      "INSERT OR REPLACE INTO t (id, v) VALUES (?, ?)",
    );
  });
  it("builds ON CONFLICT ... DO UPDATE SET on Postgres", () => {
    expect(insertOrReplace(postgres, base, ["id"], "v = excluded.v")).toBe(
      "INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v",
    );
  });
  it("supports composite conflict targets on Postgres", () => {
    expect(
      insertOrReplace(postgres, base, ["a", "b"], "v = excluded.v"),
    ).toContain("ON CONFLICT (a, b) DO UPDATE SET");
  });
});

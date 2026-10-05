import { describe, it, expect } from "vitest";
import { parseServerDate, formatServerDate, relTime, untilTime } from "./dates";

// A SQL-default timestamp ("2026-08-04 05:02:32") is UTC with nothing saying
// so, and new Date() reads it as LOCAL time — a request raised a minute ago
// rendered "5h ago" for a reader at UTC+5:30.
describe("parseServerDate", () => {
  it("reads a zoneless SQL timestamp as UTC, not local", () => {
    const d = parseServerDate("2026-08-04 05:02:32")!;
    expect(d.toISOString()).toBe("2026-08-04T05:02:32.000Z");
  });

  it("handles fractional seconds", () => {
    const d = parseServerDate("2026-08-04 05:02:32.500")!;
    expect(d.toISOString()).toBe("2026-08-04T05:02:32.500Z");
  });

  it("passes ISO strings through untouched", () => {
    const iso = "2026-08-04T05:02:32.000Z";
    expect(parseServerDate(iso)!.toISOString()).toBe(iso);
  });

  it("keeps a non-UTC offset the sender specified", () => {
    // Not our shape — must not get a Z stapled onto it.
    expect(parseServerDate("2026-08-04T05:02:32+05:30")!.toISOString()).toBe(
      "2026-08-03T23:32:32.000Z",
    );
  });

  it("returns null for empty and unparseable input", () => {
    expect(parseServerDate(null)).toBeNull();
    expect(parseServerDate(undefined)).toBeNull();
    expect(parseServerDate("")).toBeNull();
    expect(parseServerDate("not a date")).toBeNull();
  });
});

describe("relTime", () => {
  const sqlStamp = (msAgo: number) =>
    new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

  it("reads a fresh SQL timestamp as just now, whatever the local zone", () => {
    expect(relTime(sqlStamp(5_000))).toBe("just now");
  });

  it("counts from the real elapsed time", () => {
    expect(relTime(sqlStamp(90 * 60_000))).toBe("1h ago");
    expect(relTime(sqlStamp(3 * 86_400_000))).toBe("3d ago");
  });

  it("is empty for missing input rather than 'Invalid Date'", () => {
    expect(relTime(null)).toBe("");
    expect(formatServerDate(null)).toBe("");
  });
});

describe("untilTime", () => {
  const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("counts down to a future instant", () => {
    expect(untilTime(isoIn(30 * 60_000 + 5_000))).toBe("in 30m");
    expect(untilTime(isoIn(5 * 3_600_000 + 5_000))).toBe("in 5h");
    expect(untilTime(isoIn(7 * 86_400_000 + 5_000))).toBe("in 7d");
  });

  it("reads a past instant as expired, missing input as empty", () => {
    expect(untilTime(isoIn(-60_000))).toBe("expired");
    expect(untilTime(null)).toBe("");
  });
});

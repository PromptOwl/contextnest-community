import { describe, it, expect } from "vitest";
import { validateSchedule } from "./schedule-validation";

// The Schedule field accepts free-form text opaque to the server (an
// external orchestrator parses it) — this only checks whether it *looks*
// like a valid cron/interval, it never rewrites the saved value.
describe("validateSchedule", () => {
  it("treats blank as empty, not invalid — the field is optional", () => {
    expect(validateSchedule("")).toEqual({ kind: "empty" });
    expect(validateSchedule("   ")).toEqual({ kind: "empty" });
  });

  it("reads a standard 5-field cron expression", () => {
    expect(validateSchedule("0 6 * * *")).toEqual({
      kind: "valid",
      description: "Runs daily at 06:00",
    });
  });

  it("reads a weekly cron expression by day-of-week", () => {
    expect(validateSchedule("30 9 * * 1")).toEqual({
      kind: "valid",
      description: "Runs weekly on Monday at 09:30",
    });
  });

  it("reads step syntax", () => {
    expect(validateSchedule("*/15 * * * *")).toEqual({
      kind: "valid",
      description: "Runs every 15 minutes",
    });
  });

  it("expands @daily / @hourly style aliases", () => {
    expect(validateSchedule("@daily")).toEqual({
      kind: "valid",
      description: "Runs daily at 00:00",
    });
    expect(validateSchedule("@hourly")).toEqual({
      kind: "valid",
      description: "Runs hourly, on the hour",
    });
  });

  it("rejects a value out of range for its field position", () => {
    // 61 is fine as a day-of-month number lexically, but invalid in the
    // minute position (0-59) — validation must be position-aware.
    const result = validateSchedule("61 * * * *");
    expect(result.kind).toBe("invalid");
    expect((result as { error: string }).error).toMatch(/minute must be between 0 and 59/);
  });

  it("rejects a month value out of range", () => {
    const result = validateSchedule("0 0 1 13 *");
    expect(result.kind).toBe("invalid");
    expect((result as { error: string }).error).toMatch(/month must be between 1 and 12/);
  });

  it("rejects the wrong number of fields", () => {
    const result = validateSchedule("* * * *");
    expect(result.kind).toBe("invalid");
    expect((result as { error: string }).error).toMatch(/needs 5 space-separated fields/);
  });

  it("rejects garbage text with no cron/interval shape", () => {
    expect(validateSchedule("whenever I feel like it").kind).toBe("invalid");
  });

  it("reads an @every interval", () => {
    expect(validateSchedule("@every 15m")).toEqual({
      kind: "valid",
      description: "Runs every 15 minutes",
    });
    expect(validateSchedule("@every 1h30m")).toEqual({
      kind: "valid",
      description: "Runs every 1 hour 30 minutes",
    });
  });

  it("rejects a zero-length @every interval", () => {
    const result = validateSchedule("@every 0m");
    expect(result.kind).toBe("invalid");
    expect((result as { error: string }).error).toMatch(/greater than zero/);
  });

  it("rejects an @every value with no recognizable duration", () => {
    expect(validateSchedule("@every soon").kind).toBe("invalid");
  });
});

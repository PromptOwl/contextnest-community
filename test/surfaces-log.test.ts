/**
 * po-1447: one `[surfaces]` log line per caught error — the step, the ids
 * that are known, and a code. Never message text, tokens or secrets.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { logCaught } from "../src/surfaces/log.js";
import { SlackApiError } from "../src/surfaces/adapters/slack/api.js";
import { SurfaceRateLimited } from "../src/surfaces/contract.js";

function capture(level: "error" | "warn") {
  const lines: string[] = [];
  vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  return lines;
}
afterEach(() => vi.restoreAllMocks());

describe("logCaught", () => {
  it("writes one [surfaces] line with the step, the known ids and the Slack error code", () => {
    const lines = capture("error");
    logCaught("card", new SlackApiError("channel_not_found"), { install: "inst-1", binding: "bind-2", proposal: null });
    expect(lines).toEqual(["[surfaces] card failed: code=channel_not_found install=inst-1 binding=bind-2"]);
  });

  it("names a rate limit, and a plain error by its class plus a system code", () => {
    const lines = capture("error");
    logCaught("events", new SurfaceRateLimited(30));
    logCaught("commit", Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
    logCaught("judge", "not an error");
    expect(lines).toEqual([
      "[surfaces] events failed: code=ratelimited",
      "[surfaces] commit failed: code=Error:SQLITE_BUSY",
      "[surfaces] judge failed: code=error",
    ]);
  });

  it("best-effort calls log at warn level", () => {
    const warns = capture("warn");
    const errors = capture("error");
    logCaught("oauth", new SlackApiError("invalid_auth"), { install: "inst-1" }, "warn");
    expect(warns).toEqual(["[surfaces] oauth failed: code=invalid_auth install=inst-1"]);
    expect(errors).toEqual([]);
  });

  it("an error that carries message text, a token or a secret logs none of them", () => {
    const lines = capture("error");
    const TEXT = "we decided the SENTINEL-7781 launch moves to March";
    const TOKEN = "xoxb-1234-5678-abcdefSECRET";
    const err = Object.assign(new SyntaxError(`Unexpected token in "${TEXT}" with ${TOKEN}`), { code: `bad ${TOKEN}` });
    logCaught("ingest", err, { install: `inst-1 ${TEXT}`, binding: TOKEN.replace(/-/g, " ") });
    logCaught("oauth", new SlackApiError(`${TEXT} ${TOKEN}`));
    const out = lines.join("\n");
    expect(lines).toHaveLength(2);
    expect(out).not.toContain("SENTINEL");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("xoxb");
    expect(out).toContain("[surfaces] oauth failed: code=error");
  });
});

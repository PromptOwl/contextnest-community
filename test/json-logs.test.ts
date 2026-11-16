import { describe, it, expect, afterEach } from "vitest";
import { installJsonLogs } from "../src/shared/json-logs.js";

const saved = { ...console };
afterEach(() => Object.assign(console, saved));

describe("installJsonLogs", () => {
  it("turns each console call into one JSON line on the right stream", () => {
    const out: [string, string][] = [];
    installJsonLogs((stream, line) => out.push([stream, line]));
    console.log("hello %s", "world", { n: 1 });
    console.error(new Error("boom"));

    expect(out.map(([s]) => s)).toEqual(["stdout", "stderr"]);
    expect(out.every(([, l]) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true);
    const [info, err] = out.map(([, l]) => JSON.parse(l));
    expect(info).toMatchObject({ level: "info", severity: "INFO", message: "hello world { n: 1 }" });
    expect(Date.parse(info.time)).not.toBeNaN();
    expect(err.level).toBe("error");
    expect(err.message).toContain("Error: boom");
  });
});

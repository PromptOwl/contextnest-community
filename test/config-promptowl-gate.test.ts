import { describe, it, expect, afterEach } from "vitest";
import { config } from "../src/config";

afterEach(() => {
  delete process.env.PROMPTOWL_SIGN_IN_GATE;
});

describe("PROMPTOWL_SIGN_IN_GATE config", () => {
  it("defaults to open", () => {
    expect(config.PROMPTOWL_SIGN_IN_GATE).toBe("open");
  });
  it("reads admin-only", () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "admin-only";
    expect(config.PROMPTOWL_SIGN_IN_GATE).toBe("admin-only");
  });
  it("reads disabled", () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "disabled";
    expect(config.PROMPTOWL_SIGN_IN_GATE).toBe("disabled");
  });
  it("is case/space tolerant", () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "  Admin-Only ";
    expect(config.PROMPTOWL_SIGN_IN_GATE).toBe("admin-only");
  });
  it("clamps an unknown value to open (fail-safe)", () => {
    process.env.PROMPTOWL_SIGN_IN_GATE = "bogus";
    expect(config.PROMPTOWL_SIGN_IN_GATE).toBe("open");
  });
});

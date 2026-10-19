import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, callbackUrl, connectGuides, initCommand, loopbackCallback } from "./setup-page";

describe("setup page", () => {
  it("accepts only a loopback /callback", () => {
    expect(loopbackCallback("http://127.0.0.1:5123/callback")).toBe("http://127.0.0.1:5123/callback");
    expect(loopbackCallback("http://localhost:80/callback")).not.toBeNull();
    expect(loopbackCallback("http://[::1]:9/callback")).not.toBeNull();
    for (const bad of [null, "https://evil.example/callback", "http://127.0.0.1.evil.example:1/callback", "http://127.0.0.1:1/callback?x", "javascript:alert(1)"]) {
      expect(loopbackCallback(bad)).toBeNull();
    }
  });

  it("round-trips the choices through the callback URL", () => {
    const u = new URL(callbackUrl("http://127.0.0.1:1/callback", "s1", DEFAULT_CHOICES));
    expect(u.searchParams.get("state")).toBe("s1");
    expect(JSON.parse(u.searchParams.get("config")!)).toEqual(DEFAULT_CHOICES);
  });

  it("quotes user text in the init command", () => {
    const cmd = initCommand({ ...DEFAULT_CHOICES, name: "it's $(rm -rf ~)", tools: [] });
    expect(cmd).toContain(`--name 'it'\\''s $(rm -rf ~)'`);
    expect(cmd).toContain("--tools none");
  });

  it("never puts an unsafe alias into a command", () => {
    const steps = connectGuides("x; rm -rf ~").map((g) => g.steps).join("\n");
    expect(steps).not.toContain("rm -rf");
    expect(steps).toContain("<vault alias or path>");
  });
});

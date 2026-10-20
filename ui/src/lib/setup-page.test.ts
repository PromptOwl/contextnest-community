import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, callbackUrl, cloudGuides, cloudServer, connectGuides, detectedTools, initCommand, loginCommand, loopbackCallback } from "./setup-page";

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

  it("accepts only an https (or loopback) cloud server", () => {
    expect(cloudServer("https://nest.promptowl.ai/app?x=1")).toBe("https://nest.promptowl.ai");
    expect(cloudServer("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["http://nest.example.com", "javascript:alert(1)", "nest.example.com", ""]) {
      expect(cloudServer(bad)).toBeNull();
    }
  });

  it("builds the cloud login command and guides", () => {
    const c = { ...DEFAULT_CHOICES, mode: "cloud" as const, server: "https://nest.example.com", alias: "work" };
    expect(loginCommand(c)).toBe("ctx login https://nest.example.com --as work --set-default");
    expect(loginCommand({ ...c, server: "x; rm -rf ~" })).not.toContain("rm -rf");
    const steps = cloudGuides(c.server, c.alias).map((g) => g.steps).join("\n");
    expect(steps).toContain("https://nest.example.com/mcp");
  });

  it("reads detected tools from the fragment, dropping unknown ids", () => {
    expect(detectedTools("#detected=claude,gemini,evil")).toEqual(["claude", "gemini"]);
    expect(detectedTools("#detected=")).toEqual([]);
    expect(detectedTools("")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { modelOptions } from "./model-options";

const OWN = "community-lic1-openai/gpt-5.6-sol";
const providers = { "gpt-4o": "openai", "claude-sonnet-5": "claude", "grok-4": "grok", [OWN]: "openai" };

describe("modelOptions — the Hootie model picker", () => {
  it("groups by provider and marks a provider with an own key", () => {
    const opts = modelOptions(["claude-sonnet-5", "gpt-4o", "grok-4", OWN], [OWN], providers, "gpt-4o");
    expect(opts.map((o) => [o.group, o.value])).toEqual([
      ["Anthropic", "claude-sonnet-5"],
      ["OpenAI · your key", "gpt-4o"],
      ["xAI Grok", "grok-4"],
    ]);
  });

  it("shows own-model names only when nothing else lists that provider", () => {
    const opts = modelOptions(["claude-sonnet-5", OWN], [OWN], providers, "");
    expect(opts.find((o) => o.value === OWN)).toEqual({ value: OWN, label: "gpt-5.6-sol", group: "OpenAI · your key" });
  });

  it("keeps the saved model selectable when no key lists it", () => {
    const opts = modelOptions(["gpt-4o"], [], providers, "old-model");
    expect(opts[0]).toEqual({ value: "old-model", label: "old-model", group: "Current" });
    expect(opts[1].group).toBe("OpenAI");
  });
});

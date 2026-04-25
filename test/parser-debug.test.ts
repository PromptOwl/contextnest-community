import { describe, it, expect } from "vitest";
import { parseStewardsYaml } from "../src/governance/stewards-parser.js";

describe("stewards.yaml parser", () => {
  it("parses nest-level stewards", () => {
    const config = parseStewardsYaml(`nest:
  - email: lead@acme.com, role: admin, can_approve: true
`);
    expect(config.nest).toBeDefined();
    expect(config.nest!.length).toBe(1);
    expect(config.nest![0].email).toBe("lead@acme.com");
    expect(config.nest![0].role).toBe("admin");
  });

  it("parses tag-level stewards", () => {
    const config = parseStewardsYaml(`tags:
  architecture:
    - email: jane@acme.com, role: reviewer, can_approve: true
`);
    expect(config.tags).toBeDefined();
    expect(config.tags!["architecture"]).toBeDefined();
    expect(config.tags!["architecture"][0].email).toBe("jane@acme.com");
  });

  it("parses combined config", () => {
    const config = parseStewardsYaml(`version: 1
nest:
  - email: lead@acme.com, role: admin, can_approve: true
tags:
  architecture:
    - email: jane@acme.com, role: reviewer, can_approve: true
folders:
  nodes/api-*:
    - email: bob@acme.com, role: reviewer, can_approve: true
`);
    expect(config.nest!.length).toBe(1);
    expect(Object.keys(config.tags!)).toContain("architecture");
    expect(Object.keys(config.folders!)).toContain("nodes/api-*");
  });

  it("parses tag with # prefix", () => {
    const config = parseStewardsYaml(`tags:
  "#architecture":
    - email: jane@acme.com, can_approve: true
`);
    // The quotes might be stripped
    const keys = Object.keys(config.tags || {});
    expect(keys.length).toBe(1);
  });
});

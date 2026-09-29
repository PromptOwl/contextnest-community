/**
 * The API-only access panel's decisions (CU-wdqcq0314u), kept pure so they
 * can be tested without a DOM: when the switch can be turned on, how a key's
 * label is validated before minting, and how a key's last use reads.
 */
import { describe, it, expect } from "vitest";
import {
  headlessToggleBlockReason,
  validateKeyLabel,
  keyLastUsedLabel,
  connectSnippet,
} from "../ui/src/lib/headless";

describe("headlessToggleBlockReason", () => {
  it("allows turning on for a private nest, and always allows turning off", () => {
    expect(headlessToggleBlockReason("private", false)).toBeNull();
    expect(headlessToggleBlockReason("public", true)).toBeNull();
  });
  it("explains why an org or public nest can't be published API-only", () => {
    expect(headlessToggleBlockReason("public", false)).toMatch(/private/i);
    expect(headlessToggleBlockReason("org", false)).toMatch(/private/i);
  });
});

describe("validateKeyLabel", () => {
  it("requires a name for who the key is for", () => {
    expect(validateKeyLabel("   ")).toMatch(/name/i);
    expect(validateKeyLabel("Acme Corp")).toBeNull();
  });
  it("caps the length like the server does", () => {
    expect(validateKeyLabel("x".repeat(81))).toMatch(/80/);
    expect(validateKeyLabel("x".repeat(80))).toBeNull();
  });
});

describe("keyLastUsedLabel", () => {
  it("says never for an unused key, otherwise the date", () => {
    expect(keyLastUsedLabel(null)).toBe("Never used");
    expect(keyLastUsedLabel("2026-09-28 10:00:00")).toMatch(/^Last used /);
  });
});

describe("connectSnippet", () => {
  it("gives the per-nest MCP URL and the key, ready to paste", () => {
    const s = connectSnippet("https://nest.example.com", "n1", "cnst_abc");
    expect(s).toContain("https://nest.example.com/nests/n1/mcp");
    expect(s).toContain("cnst_abc");
  });
});

import { sharedSeatsNote } from "../ui/src/lib/headless";

describe("sharedSeatsNote", () => {
  it("says who keeps access, or nothing when nobody is shared", () => {
    expect(sharedSeatsNote(undefined)).toBeNull();
    expect(sharedSeatsNote({ collaborators: 0, teams: 0, grants: 0 })).toBeNull();
    const n = sharedSeatsNote({ collaborators: 2, teams: 1, grants: 0 })!;
    expect(n).toMatch(/2 collaborators/);
    expect(n).toMatch(/1 team/);
    expect(n).toMatch(/keep/i);
  });
});

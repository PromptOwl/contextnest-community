import { describe, it, expect, beforeAll } from "vitest";
import {
  extractMentions,
  newMentions,
  resolveMention,
} from "../src/shared/mentions.js";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

describe("mention parsing", () => {
  it("reads the three written forms, once each", () => {
    expect(
      extractMentions("hi @ada, @(Grace Hopper) and @ada@acme.com — @ada again"),
    ).toEqual(["ada", "Grace Hopper", "ada@acme.com"]);
  });

  it("ignores an @ inside code, where it is source", () => {
    expect(extractMentions("`@ada`")).toEqual([]);
    expect(extractMentions("```\nnpm i @scope/pkg\n```")).toEqual([]);
  });

  it("ignores an @ mid-word", () => {
    expect(extractMentions("file@host")).toEqual([]);
  });

  it("reports only what a save adds", () => {
    expect(newMentions("cc @ada", "cc @ada and @grace")).toEqual(["grace"]);
    expect(newMentions("cc @ada", "cc @ADA")).toEqual([]);
  });

  it("resolves a name to a person by email, local part or display name", () => {
    const people = [{ email: "grace@acme.com", name: "Grace Hopper" }];
    expect(resolveMention(people, "grace")?.email).toBe("grace@acme.com");
    expect(resolveMention(people, "grace@acme.com")?.email).toBe("grace@acme.com");
    expect(resolveMention(people, "Grace Hopper")?.email).toBe("grace@acme.com");
    expect(resolveMention(people, "Editor")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mention notifications (CU-wdqcpzzmju) — a mention reaches the person named.
// ═══════════════════════════════════════════════════════════════════════════

describe("mention notifications", () => {
  let app: any;
  let owner: { apiKey: string };
  let editor: { apiKey: string };
  let nestId: string;

  const inbox = async (caller: { apiKey: string }) => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/me/notifications",
      undefined,
      caller.apiKey,
    );
    return data.notifications as Array<{
      kind: string;
      message: string;
      node_id: string | null;
    }>;
  };

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    editor = await registerUser(app, "editor@acme.com", "Editor");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Mentions" },
      owner.apiKey,
    );
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "editor@acme.com", permission: "write" },
      owner.apiKey,
    );
  });

  it("notifies the mentioned person, linking the document", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Kickoff", content: "cc @editor@acme.com" },
      owner.apiKey,
    );
    const rows = (await inbox(editor)).filter((n) => n.kind === "mention");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("owner@acme.com mentioned you");
    expect(rows[0].message).toContain("Kickoff");
    expect(rows[0].node_id).toBe("nodes/kickoff");
  });

  it("stays quiet for a name nobody on the nest carries", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Ghosts", content: "cc @nobody" },
      owner.apiKey,
    );
    expect((await inbox(editor)).filter((n) => n.kind === "mention")).toHaveLength(1);
  });

  it("does not re-notify a mention that was already there", async () => {
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/kickoff`,
      { content: "cc @editor@acme.com\n\nmore body" },
      owner.apiKey,
    );
    expect((await inbox(editor)).filter((n) => n.kind === "mention")).toHaveLength(1);
  });

  it("notifies the newly named person, and never the author", async () => {
    const reviewer = await registerUser(app, "rev@acme.com", "Rev");
    await resetAuthRateLimit();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "rev@acme.com", permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/kickoff`,
      { content: "cc @editor@acme.com, @rev@acme.com and @owner@acme.com" },
      owner.apiKey,
    );
    expect((await inbox(reviewer)).filter((n) => n.kind === "mention")).toHaveLength(1);
    // The name already in the body doesn't fire twice…
    expect((await inbox(editor)).filter((n) => n.kind === "mention")).toHaveLength(1);
    // …and the author never hears about their own mention.
    expect((await inbox(owner)).filter((n) => n.kind === "mention")).toHaveLength(0);
  });
});

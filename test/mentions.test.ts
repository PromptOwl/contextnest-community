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

  it("resolves a local part shared by two people to neither", () => {
    const people = [{ email: "john@acme.com" }, { email: "john@other.com" }];
    // Guessing one of them would notify the wrong John, silently.
    expect(resolveMention(people, "john")).toBeUndefined();
    // The full address is unambiguous and still resolves.
    expect(resolveMention(people, "john@other.com")?.email).toBe("john@other.com");
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

  it("stays quiet for someone granted a different document", async () => {
    // A grantee is on the nest's people (they can be mentioned in what they
    // were shared) but must never learn a document exists from a mention of
    // them in it. Their scoping lives in the request middleware, so this is
    // the one recipient canReadNode alone would wave through.
    const guest = await registerUser(app, "guest@acme.com", "Guest");
    await resetAuthRateLimit();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared With Guest", content: "for the guest" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-with-guest",
        email: "guest@acme.com",
        role: "read",
      },
      owner.apiKey,
    );

    // Mentioned in a document they hold no grant on → nothing.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/ghosts`,
      { content: "cc @guest@acme.com" },
      owner.apiKey,
    );
    expect((await inbox(guest)).filter((n) => n.kind === "mention")).toHaveLength(0);

    // Mentioned in the document they were granted → notified.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-with-guest`,
      { content: "cc @guest@acme.com" },
      owner.apiKey,
    );
    const rows = (await inbox(guest)).filter((n) => n.kind === "mention");
    expect(rows).toHaveLength(1);
    expect(rows[0].node_id).toBe("nodes/shared-with-guest");
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

describe("stripMentions", () => {
  it("removes both mention forms and keeps the words around them", async () => {
    const { stripMentions } = await import("../src/shared/mentions.js");
    expect(stripMentions("@alice@acme.com how do requests authenticate?")).toBe(
      "how do requests authenticate?",
    );
    expect(stripMentions("ask @(Bob Jones) and @carol about the runbook")).toBe(
      "ask and about the runbook",
    );
  });
  it("leaves an @ inside code alone — there it is source, not a mention", async () => {
    const { stripMentions } = await import("../src/shared/mentions.js");
    expect(stripMentions("what does `@decorator` do? @alice")).toBe(
      "what does `@decorator` do?",
    );
  });
});

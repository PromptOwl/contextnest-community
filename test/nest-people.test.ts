import { describe, it, expect, beforeAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// GET /nests/:id/collaborators — the `people` union (CU-wdqcpzzmju)
//
// The @mention picker asks "who can reach this nest", which the collaborator
// roster alone can't answer: the owner and stewards hold no nest_collaborators
// row. `people` unions the access paths and dedupes by email, highest
// precedence kept.
// ═══════════════════════════════════════════════════════════════════════════

describe("nest people union", () => {
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    await registerUser(app, "editor@acme.com", "Editor");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "People Vault" },
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
    // A steward who is NOT a collaborator, and one who is — the second must
    // not appear twice, and must keep the higher-precedence source.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      {
        scope: "nest",
        users: [
          { email: "steward@acme.com", role: "reviewer" },
          { email: "editor@acme.com", role: "reviewer" },
        ],
      },
      owner.apiKey,
    );
  });

  const people = async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    return data.people as Array<{ email: string; source: string }>;
  };

  it("includes the owner, who holds no collaborator row", async () => {
    const found = (await people()).find((p) => p.email === "owner@acme.com");
    expect(found?.source).toBe("owner");
  });

  it("includes the members of a team the nest is shared with", async () => {
    const teammate = await registerUser(app, "teammate@acme.com", "Teammate");
    await resetAuthRateLimit();
    const team = await jsonRequest(
      app,
      "POST",
      "/teams",
      { name: "Platform" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/teams/${team.data.team.id}/members`,
      { user_id: (teammate as any).userId, role: "editor" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/teams`,
      { team_id: team.data.team.id },
      owner.apiKey,
    );
    const found = (await people()).find((p) => p.email === "teammate@acme.com");
    expect(found?.source).toBe("team");
  });

  it("includes a steward with no collaborator row", async () => {
    const found = (await people()).find((p) => p.email === "steward@acme.com");
    expect(found?.source).toBe("steward");
  });

  it("lists someone on two paths once, at the higher precedence", async () => {
    const rows = (await people()).filter(
      (p) => p.email === "editor@acme.com",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("collaborator");
  });

  it("leaves the manageable roster to collaborator rows alone", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    expect(
      data.collaborators.map((cl: { email: string }) => cl.email),
    ).toEqual(["editor@acme.com"]);
  });
});

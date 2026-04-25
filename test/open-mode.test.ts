import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers.js";

describe("open mode (no auth required)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
  });

  afterAll(() => env.cleanup());

  it("health check returns ok with open auth mode", async () => {
    const res = await app.request("/health");
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.auth_mode).toBe("open");
  });

  it("can create a nest without auth", async () => {
    const { status, data } = await jsonRequest(app, "POST", "/nests", {
      name: "Team Knowledge",
      description: "Shared team docs",
    });
    expect(status).toBe(201);
    expect(data.nest.name).toBe("Team Knowledge");
    expect(data.nest.slug).toBe("team-knowledge");
  });

  it("can list nests without auth", async () => {
    const { status, data } = await jsonRequest(app, "GET", "/nests");
    expect(status).toBe(200);
    expect(data.nests.length).toBeGreaterThanOrEqual(1);
  });

  it("can create a node without auth", async () => {
    // Get the nest ID first
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Getting Started",
        content: "# Welcome\n\nThis is the getting started guide.",
        tags: ["onboarding", "guide"],
      },
    );
    expect(status).toBe(201);
    expect(data.node.title).toBe("Getting Started");
    expect(data.node.tags).toContain("#onboarding");
  });

  it("can list nodes without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
    );
    expect(status).toBe(200);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.nodes[0].title).toBe("Getting Started");
  });

  it("can search nodes without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const res = await app.request(`/nests/${nestId}/search?q=welcome`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.count).toBe(1);
  });

  it("can get vault overview without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/overview`,
    );
    expect(status).toBe(200);
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it("can run selector query without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    // Selector queries require the engine to discover documents first;
    // use type:document which matches broadly
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/query`,
      { query: "type:document" },
    );
    expect(status).toBe(200);
    // Engine may or may not find nodes depending on discovery timing,
    // but the endpoint should work without error
    expect(typeof data.count).toBe("number");
  });

  it("can bulk publish without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      {
        documents: [
          {
            title: "API Reference",
            content: "# API Docs\n\nEndpoints here.",
            tags: ["api"],
          },
          {
            title: "Architecture",
            content: "# Arch\n\nSystem design.",
            tags: ["engineering"],
          },
        ],
        context_md: "# Team Vault\n\nUse this vault for team knowledge.",
      },
    );
    expect(status).toBe(201);
    expect(data.published).toBe(2);
    expect(data.context_md_updated).toBe(true);
  });

  it("can update a node without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/getting-started`,
      { append: "\n## Next Steps\n\nRead the API docs.", tags: ["updated"] },
    );
    expect(status).toBe(200);
    expect(data.node.tags).toContain("#updated");
    expect(data.node.content).toContain("Next Steps");
  });

  it("can delete a node without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/architecture`,
    );
    expect(status).toBe(200);
    expect(data.deleted).toBe(true);
  });

  it("can read CONTEXT.md without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/context`,
    );
    expect(status).toBe(200);
    expect(data.content).toContain("Team Vault");
  });

  it("can delete a nest without auth", async () => {
    const { data: listData } = await jsonRequest(app, "GET", "/nests");
    const nestId = listData.nests[0].id;

    const { status, data } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}`,
    );
    expect(status).toBe(200);
    expect(data.deleted).toBe(true);
  });
});

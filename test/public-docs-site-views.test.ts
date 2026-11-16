/**
 * CU-wdqcq05rap — a §1.12 view on the public docs site. The site renders only
 * the view's approved intro plus a notice, as `/p` does: it never resolves the
 * view's blocks, never frames an artifact, never injects nest-data, and never
 * emits the `view:` frontmatter (bindings, callout text) in the page, the
 * Markdown twin or llms-full.txt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { SITE_VIEW_NOTICE } from "../src/site/build.js";

const HTML = { Accept: "text/html" };
const ART_HTML =
  "<!doctype html><html><head><script>/*app*/</script></head><body>ARTIFACT-SECRET</body></html>";
const SECRETS = ["TABLE-SECRET", "ARTIFACT-SECRET", "CALLOUT-SECRET", "TASK-SECRET", "nest-data", "<iframe"];

describe("public docs site: view nodes", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  const get = (path: string, headers: Record<string, string> = HTML) =>
    app.request(`http://localhost${path}`, { headers });

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@siteview.test", "Owner");
    const created = await jsonRequest(app, "POST", "/nests", { name: "View Docs" }, owner.apiKey);
    nestId = created.data.nest.id;
    const mk = async (body: Record<string, unknown>) => {
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { folder: "docs", ...body }, owner.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.node.id as string;
    };
    await mk({ title: "Welcome", content: "# Welcome\n\nHome page." });
    const tId = await mk({ title: "Ledger", type: "table", content: "id,label\nr1,TABLE-SECRET" });
    await mk({ title: "Sprint Task", type: "task", content: "TASK-SECRET", tags: ["#sprint"] });
    const aId = await mk({ title: "Dash Art", type: "artifact", content: ART_HTML });
    await mk({
      title: "Live Dash",
      type: "view",
      content: "Public **intro** of the dashboard.",
      view: {
        blocks: [
          { id: "d", data: { binding: tId } },
          { id: "t", list: { select: "#sprint" } },
          { callout: { text: "CALLOUT-SECRET" } },
          { html: { ref: aId, data_from: ["d", "t"] } },
        ],
      },
    });

    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status, JSON.stringify(vis.data)).toBe(200);
    const rm = await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true, home_node: "nodes/docs/welcome" }, owner.apiKey);
    expect(rm.status, JSON.stringify(rm.data)).toBe(200);
  }, 90000);

  afterAll(() => {
    delete process.env.DOCS_SITES;
    env.cleanup();
  });

  it("renders a view as its intro plus the notice, with no data or frames", async () => {
    const res = await get("/d/view-docs/live-dash");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>intro</strong>");
    expect(html).toContain(SITE_VIEW_NOTICE);
    for (const s of SECRETS) expect(html, s).not.toContain(s);
  });

  it("the Markdown twin and llms-full.txt carry the intro only", async () => {
    const md = await (await get("/d/view-docs/live-dash.md", {})).text();
    expect(md).toContain("Public **intro** of the dashboard.");
    expect(md).toContain(SITE_VIEW_NOTICE);
    const full = await (await get("/d/view-docs/llms-full.txt", {})).text();
    expect(full).toContain(SITE_VIEW_NOTICE);
    for (const s of [...SECRETS, "binding", "data_from"]) expect(md, s).not.toContain(s);
    // The table and task are public docs pages in their own right; what must not
    // appear is anything only the view's blocks would have produced.
    for (const s of ["CALLOUT-SECRET", "ARTIFACT-SECRET", "nest-data", "<iframe", "data_from"]) {
      expect(full, s).not.toContain(s);
    }
  });

  it("artifacts are still not docs pages", async () => {
    expect((await get("/d/view-docs/dash-art")).status).toBe(404);
  });
});

/**
 * §1.12 views on `/p` (AC-13): a published view renders its own approved
 * intro and one neutral placeholder per block. `/p` never resolves another
 * node's content, never frames an artifact and never injects nest-data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { ARTIFACT_SANDBOX_CSP } from "../src/shared/artifact-sandbox.js";

const ART_HTML =
  "<!doctype html><html><head><script>/*app*/</script></head><body>ARTIFACT-SECRET</body></html>";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;
let slug: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@pview.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Pub Views" }, owner.apiKey);
  nestId = nest.data.nest.id;
  const mk = async (body: Record<string, unknown>) => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data.node.id as string;
  };
  await mk({ title: "Intro", content: "INTRO-SECRET body" });
  const tId = await mk({ title: "Ledger", type: "table", content: "id,label\nr1,TABLE-SECRET" });
  const aId = await mk({ title: "Dash", type: "artifact", content: ART_HTML });
  const vId = await mk({
    title: "Published View",
    type: "view",
    content: "Public **intro** of the view.",
    view: {
      blocks: [
        { md: { ref: "nodes/intro" } },
        { id: "d", data: { binding: tId } },
        { callout: { text: "CALLOUT-TEXT" } },
        { id: "h", html: { ref: aId, data_from: ["d"] } },
      ],
    },
  });
  const pub = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/publications`,
    { node_id: vId, access_mode: "public" },
    owner.apiKey,
  );
  expect(pub.status, JSON.stringify(pub.data)).toBe(201);
  slug = pub.data.publish.slug;
});

afterAll(() => env.cleanup());

describe("AC-13: /p for a view", () => {
  for (const suffix of ["", "/view"]) {
    it(`/p/:slug${suffix} shows the intro and placeholders, and nothing it would have to resolve`, async () => {
      const res = await app.request(`/p/${slug}${suffix}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
      const body = await res.text();
      expect(body).toContain("<strong>intro</strong>");
      expect((body.match(/Available to nest members/g) || []).length).toBe(4);
      expect(body).not.toContain("nest-data");
      expect(body).not.toContain("<iframe");
      for (const secret of ["INTRO-SECRET", "TABLE-SECRET", "ARTIFACT-SECRET", "CALLOUT-TEXT"]) {
        expect(body, secret).not.toContain(secret);
      }
    });
  }
});

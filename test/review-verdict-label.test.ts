import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// approve/reject resolve the document label once (buildDocContext) and hand it
// to the verdict fan-out, so notifyReviewResolved must use it as given rather
// than walking the nest's title map a second time.
describe("notifyReviewResolved: caller-supplied label", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let nestId: string;
  let db: any;
  let notifyReviewResolved: typeof import("../src/governance/notify-service.js").notifyReviewResolved;

  beforeAll(async () => {
    env = setupTestEnv();
    const app = await createTestApp("key");
    const user = await registerUser(app, "owner@acme.com", "Owner");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Label Nest" }, user.apiKey);
    nestId = data.nest.id;

    // Post-resetModules instances — the ones the running app uses.
    const client = await import("../src/db/client.js");
    db = client.getDb();
    ({ notifyReviewResolved } = await import("../src/governance/notify-service.js"));
  }, 30000);

  afterAll(() => env.cleanup());

  it("writes the given label into the inbox row", async () => {
    // No document exists at this id, so a lookup would fall back to the slug.
    await notifyReviewResolved({
      nestId,
      nodeId: "nodes/api/missing-doc",
      status: "approved",
      resolvedBy: "bob@acme.com",
      requestedBy: "alice@acme.com",
      reviewId: "r1",
      label: "Rate Limits (in api)",
    });

    const row = (await db.get(
      "SELECT message FROM notifications WHERE subject_id = 'r1' AND user_email = 'alice@acme.com'",
    )) as { message: string };
    expect(row.message).toBe(`"Rate Limits (in api)" was approved by bob@acme.com`);
  });
});

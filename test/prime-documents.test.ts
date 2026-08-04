/**
 * Prime documents — a per-document / per-tag escalation on top of the nest's
 * governance posture.
 *
 * Two independent things are locked here:
 *   1. A prime document ALWAYS goes through review, even for an owner whose
 *      nest has allow_self_approve on. Prime beats every bypass.
 *   2. `prime_only_review` flips the governed nest's default: non-prime docs
 *      self-publish for everyone, prime docs still queue.
 *
 * Resolution order is document → tag → nest, so a document-scope `prime: false`
 * exempts one doc from an otherwise-prime tag.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let nestId: string;

async function statusOf(caller: any, slug: string): Promise<string> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes`,
    undefined,
    caller.apiKey,
  );
  return data.nodes.find((n: any) => n.id === `nodes/${slug}`)?.status;
}

async function createDoc(caller: any, body: Record<string, unknown>) {
  return jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, caller.apiKey);
}

async function setSettings(body: Record<string, unknown>) {
  return jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    body,
    owner.apiKey,
  );
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");

  const { data } = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Nest" },
    owner.apiKey,
  );
  nestId = data.nest.id;
  // Governed + self-approve on: the hardest case for prime to survive, since
  // the owner would otherwise publish straight through.
  await setSettings({ stewardship_enabled: true, allow_self_approve: true });

  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${editor.email}, role: editor\n`,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards/sync`,
    {},
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("prime beats the self-approve bypass", () => {
  it("owner's non-prime doc still publishes immediately", async () => {
    await createDoc(owner, { title: "call-notes", content: "notes" });
    expect(await statusOf(owner, "call-notes")).toBe("published");
  });

  it("owner's doc flagged prime lands as a draft", async () => {
    await createDoc(owner, {
      title: "playbook",
      content: "the playbook",
      prime: true,
    });
    expect(await statusOf(owner, "playbook")).toBe("draft");
  });

  it("owner's doc carrying the default prime tag lands as a draft", async () => {
    await createDoc(owner, {
      title: "messaging",
      content: "architecture",
      tags: ["prime-document"],
    });
    expect(await statusOf(owner, "messaging")).toBe("draft");
  });

  it("adding a prime tag on edit gates that same edit", async () => {
    await createDoc(owner, { title: "grows-prime", content: "v1" });
    expect(await statusOf(owner, "grows-prime")).toBe("published");
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/grows-prime`,
      { content: "v2", tags: ["prime-document"] },
      owner.apiKey,
    );
    expect(await statusOf(owner, "grows-prime")).toBe("draft");
  });
});

describe("document scope beats tag scope", () => {
  it("prime:false exempts a doc from an otherwise-prime tag", async () => {
    await createDoc(owner, {
      title: "exempt",
      content: "body",
      tags: ["prime-document"],
      prime: false,
    });
    expect(await statusOf(owner, "exempt")).toBe("published");
  });
});

describe("prime tag set is configurable", () => {
  it("a custom tag marks docs prime and the old default stops doing so", async () => {
    await setSettings({ prime_tags: ["#High-Stakes"] });
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    // Normalized server-side: no leading '#', lowercased.
    expect(data.prime_tags).toEqual(["high-stakes"]);

    await createDoc(owner, {
      title: "custom-prime",
      content: "body",
      tags: ["high-stakes"],
    });
    expect(await statusOf(owner, "custom-prime")).toBe("draft");

    await createDoc(owner, {
      title: "no-longer-prime",
      content: "body",
      tags: ["prime-document"],
    });
    expect(await statusOf(owner, "no-longer-prime")).toBe("published");

    await setSettings({ prime_tags: ["prime-document"] });
  });
});

describe("prime_only_review posture", () => {
  it("off by default — an editor's ordinary doc still drafts", async () => {
    await createDoc(editor, { title: "editor-default", content: "body" });
    expect(await statusOf(owner, "editor-default")).toBe("draft");
  });

  it("on — an editor's non-prime doc self-publishes", async () => {
    await setSettings({ prime_only_review: true });
    await createDoc(editor, { title: "editor-casual", content: "body" });
    expect(await statusOf(owner, "editor-casual")).toBe("published");
  });

  it("on — an editor's prime doc still drafts", async () => {
    await createDoc(editor, {
      title: "editor-prime",
      content: "body",
      tags: ["prime-document"],
    });
    expect(await statusOf(owner, "editor-prime")).toBe("draft");
    await setSettings({ prime_only_review: false });
  });
});

describe("flagging prime is a governance action", () => {
  it("an editor cannot set the prime flag", async () => {
    const { status } = await createDoc(editor, {
      title: "editor-flagged",
      content: "body",
      prime: false,
    });
    expect(status).toBe(403);
  });

  it("an editor cannot clear an owner's prime flag on edit", async () => {
    await createDoc(owner, {
      title: "owner-flagged",
      content: "v1",
      prime: true,
    });
    const { status } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/owner-flagged`,
      { content: "v2", prime: null },
      editor.apiKey,
    );
    expect(status).toBe(403);
  });
});

describe("ungoverned nests are untouched", () => {
  it("a prime-tagged doc publishes when stewardship is off", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Ungoverned" },
      owner.apiKey,
    );
    const openNest = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${openNest}/nodes`,
      { title: "free", content: "body", tags: ["prime-document"] },
      owner.apiKey,
    );
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${openNest}/nodes`,
      undefined,
      owner.apiKey,
    );
    expect(
      list.data.nodes.find((n: any) => n.id === "nodes/free")?.status,
    ).toBe("published");
  });
});

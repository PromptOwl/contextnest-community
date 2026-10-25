/**
 * Server admins can stop nest owners widening a nest to Public or Organization
 * (task community-nest-server-admins-can-stop-owners-making-nests-public-or-org-wide).
 *
 * Two runtime settings, NEST_PUBLIC_VISIBILITY and NEST_ORG_VISIBILITY, each
 * `owners` (default — today's behaviour) or `admins`. With `admins`, only a
 * server admin may widen a nest to that tier; narrowing is always allowed.
 * Enforced on every path that widens: REST PATCH /nests/:id/visibility and
 * its MCP twin context_set_visibility (one service, so they can't drift).
 *
 * GWT:
 *  1. defaults (owners): an owner publishes with the acknowledgement as before
 *  2. settings round-trip on /admin/settings (server admin only) and /health
 *  3. public=admins: owner → 403 naming the setting, nest unchanged;
 *     superadmin → 200; owner can still narrow to private
 *  4. org=admins: owner → 403; a public nest can still narrow to org
 *  5. open mode (AUTH_MODE=open) ignores the cap
 *  6. the widening write is conditional on the tier the cap was checked against
 *  7. MCP refuses the same widening the same way; acknowledge is boolean-only
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { getDb } from "../src/db/client";
import { setNestVisibility, visibilityRestriction } from "../src/nests/visibility-service";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: User; // superadmin (access.yaml), not on the nest
let owner: User;
let nestId: string;

const setVisibility = (visibility: string, key: string, ack = true) =>
  jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/visibility`,
    ack ? { visibility, acknowledge_public: true } : { visibility },
    key,
  );
const visibilityNow = async () =>
  (await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, owner.apiKey)).data.nest
    .visibility as string;
/** Put the nest back to a known tier as the superadmin, whatever the gate says. */
const reset = async (v: string) => {
  const r = await setVisibility(v, root.apiKey);
  expect(r.status).toBe(200);
};

beforeAll(async () => {
  env = setupTestEnv();
  delete process.env.NEST_PUBLIC_VISIBILITY;
  delete process.env.NEST_ORG_VISIBILITY;
  delete process.env.SHARED_DEPLOYMENT;
  app = await createTestApp("key", { superAdmins: ["root@cap.test"] });
  root = await registerUser(app, "root@cap.test", "Root");
  owner = await registerUser(app, "owner@cap.test", "Owner");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Cap" }, owner.apiKey)).data.nest.id;
});

afterEach(async () => {
  delete process.env.NEST_PUBLIC_VISIBILITY;
  delete process.env.NEST_ORG_VISIBILITY;
  await reset("private");
});

afterAll(() => env.cleanup());

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcp(
  method: string,
  params: Record<string, unknown>,
  key: string,
): Promise<any> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : {};
}
const callTool = async (args: Record<string, unknown>, key: string) => {
  const body = await mcp("tools/call", { name: "context_set_visibility", arguments: args }, key);
  return {
    isError: !!body?.result?.isError || !!body?.error,
    text: body?.error?.message ?? (body?.result?.content ?? []).map((p: any) => p?.text ?? "").join(""),
  };
};

describe("GWT 1 — defaults leave today's behaviour alone", () => {
  it("an owner publishes with the acknowledgement and opens to org", async () => {
    expect((await setVisibility("public", owner.apiKey)).status).toBe(200);
    expect(await visibilityNow()).toBe("public");
    expect((await setVisibility("org", owner.apiKey)).status).toBe(200);
    expect(await visibilityNow()).toBe("org");
  });

  it("public still needs the acknowledgement (409 without it)", async () => {
    const r = await setVisibility("public", owner.apiKey, false);
    expect(r.status).toBe(409);
    expect(r.data.requires_acknowledgement).toBe(true);
  });
});

describe("GWT 2 — the settings", () => {
  it("round-trip on /admin/settings for a server admin; bad values are rejected", async () => {
    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.nest_public_visibility).toBe("owners");
    expect(before.data.nest_org_visibility).toBe("owners");

    const bad = await jsonRequest(app, "PATCH", "/admin/settings", { nest_public_visibility: "nobody" }, root.apiKey);
    expect(bad.status).toBe(400);
    expect(bad.data.fieldErrors.nest_public_visibility).toMatch(/owners or admins/);

    const on = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { nest_public_visibility: "admins", nest_org_visibility: "admins" },
      root.apiKey,
    );
    expect(on.status).toBe(200);
    expect(on.data.settings.nest_public_visibility).toBe("admins");
    expect(on.data.settings.nest_org_visibility).toBe("admins");
    const got = await jsonRequest(app, "GET", "/admin/settings", undefined, root.apiKey);
    expect(got.data.nest_public_visibility).toBe("admins");
    expect(got.data.nest_org_visibility).toBe("admins");

    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { nest_public_visibility: "owners", nest_org_visibility: "owners" },
      root.apiKey,
    );
    expect(off.data.settings.nest_public_visibility).toBe("owners");
    expect(off.data.settings.nest_org_visibility).toBe("owners");
  });

  it("a nest owner who isn't a server admin can't read or change them", async () => {
    expect((await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey)).status).toBe(403);
    const r = await jsonRequest(app, "PATCH", "/admin/settings", { nest_public_visibility: "owners" }, owner.apiKey);
    expect(r.status).toBe(403);
  });

  it("/health reports both so the UI can disable the blocked tiers", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const h = await jsonRequest(app, "GET", "/health");
    expect(h.data.nest_public_visibility).toBe("admins");
    expect(h.data.nest_org_visibility).toBe("owners");
  });
});

describe("GWT 3 — public = admins", () => {
  it("an owner is refused with a 403 that names the setting; the nest stays private", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const r = await setVisibility("public", owner.apiKey);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("visibility_restricted");
    expect(r.data.error).toMatch(/Who can make nests public/);
    expect(r.data.error).toMatch(/server admin/i);
    expect(await visibilityNow()).toBe("private");
  });

  it("the refusal comes before the acknowledgement prompt", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const r = await setVisibility("public", owner.apiKey, false);
    expect(r.status).toBe(403);
  });

  it("a superadmin makes the same nest public (with the acknowledgement, as today)", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    expect((await setVisibility("public", root.apiKey, false)).status).toBe(409);
    const r = await setVisibility("public", root.apiKey);
    expect(r.status).toBe(200);
    expect(await visibilityNow()).toBe("public");
  });

  it("the owner can still narrow a public nest to private", async () => {
    await reset("public");
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const r = await setVisibility("private", owner.apiKey, false);
    expect(r.status).toBe(200);
    expect(await visibilityNow()).toBe("private");
  });

  it("org stays open to the owner while only public is restricted", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    expect((await setVisibility("org", owner.apiKey)).status).toBe(200);
    expect(await visibilityNow()).toBe("org");
  });
});

describe("GWT 4 — org = admins", () => {
  it("an owner is refused; the nest stays private", async () => {
    process.env.NEST_ORG_VISIBILITY = "admins";
    const r = await setVisibility("org", owner.apiKey);
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("visibility_restricted");
    expect(r.data.error).toMatch(/Who can make nests organization-wide/);
    expect(await visibilityNow()).toBe("private");
  });

  it("a superadmin can open it to the organization", async () => {
    process.env.NEST_ORG_VISIBILITY = "admins";
    expect((await setVisibility("org", root.apiKey)).status).toBe(200);
    expect(await visibilityNow()).toBe("org");
  });

  it("narrowing a public nest to org is allowed — it reaches fewer people", async () => {
    await reset("public");
    process.env.NEST_ORG_VISIBILITY = "admins";
    const r = await setVisibility("org", owner.apiKey);
    expect(r.status).toBe(200);
    expect(await visibilityNow()).toBe("org");
  });

  it("the owner can narrow an org nest to private", async () => {
    await reset("org");
    process.env.NEST_ORG_VISIBILITY = "admins";
    expect((await setVisibility("private", owner.apiKey)).status).toBe(200);
  });
});

describe("GWT 5 — open mode ignores the cap", () => {
  it("AUTH_MODE=open lets the anonymous caller widen; key mode refuses the same call", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const prev = process.env.AUTH_MODE;
    try {
      process.env.AUTH_MODE = "open";
      expect(await visibilityRestriction(owner.userId, "private", "public")).toBeNull();
      process.env.AUTH_MODE = "key";
      expect(await visibilityRestriction(owner.userId, "private", "public")).toMatch(
        /Who can make nests public/,
      );
    } finally {
      if (prev === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = prev;
    }
  });
});

describe("GWT 6 — a stale tier can't turn a narrowing into a widening", () => {
  it("org = admins: the owner's 'narrow to org' read public, but the nest went private — 409, stays private", async () => {
    process.env.NEST_ORG_VISIBILITY = "admins";
    expect(await visibilityNow()).toBe("private");
    // The service's first read sees the nest as public (as if another request
    // narrowed it to private between that read and the write).
    const db = getDb();
    const spy = vi.spyOn(db, "get").mockResolvedValueOnce({ visibility: "public" } as any);
    try {
      const r = await setNestVisibility(nestId, owner.userId, "org", true);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await visibilityNow()).toBe("private");
  });
});

describe("GWT 7 — MCP parity (context_set_visibility)", () => {
  it("is advertised to the nest owner", async () => {
    const list = await mcp("tools/list", {}, owner.apiKey);
    expect((list?.result?.tools ?? []).map((t: any) => t.name)).toContain("context_set_visibility");
  });

  it("with defaults, an owner sets public with acknowledge and gets the ack prompt without it", async () => {
    const noAck = await callTool({ visibility: "public" }, owner.apiKey);
    expect(noAck.isError).toBe(true);
    expect(noAck.text).toMatch(/acknowledg/i);
    expect(await visibilityNow()).toBe("private");
    const ok = await callTool({ visibility: "public", acknowledge: true }, owner.apiKey);
    expect(ok.isError).toBe(false);
    expect(await visibilityNow()).toBe("public");
  });

  it("public = admins: the owner is refused the same way; the superadmin isn't", async () => {
    process.env.NEST_PUBLIC_VISIBILITY = "admins";
    const r = await callTool({ visibility: "public", acknowledge: true }, owner.apiKey);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Who can make nests public/);
    expect(await visibilityNow()).toBe("private");
    const ok = await callTool({ visibility: "public", acknowledge: true }, root.apiKey);
    expect(ok.isError).toBe(false);
    expect(await visibilityNow()).toBe("public");
  });

  it("org = admins: the owner is refused over MCP; narrowing to private still works", async () => {
    process.env.NEST_ORG_VISIBILITY = "admins";
    const r = await callTool({ visibility: "org", acknowledge: true }, owner.apiKey);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Who can make nests organization-wide/);
    await reset("org");
    const down = await callTool({ visibility: "private" }, owner.apiKey);
    expect(down.isError).toBe(false);
    expect(await visibilityNow()).toBe("private");
  });

  it("acknowledge must be the boolean true — the string \"true\" is not an acknowledgement (same as REST)", async () => {
    const r = await callTool({ visibility: "public", acknowledge: "true" }, owner.apiKey);
    expect(r.isError).toBe(true);
    expect(await visibilityNow()).toBe("private");
  });
});

describe("GWT 8 — ordering and who sees the MCP tool", () => {
  it("shared deployment + org = admins: the owner gets the 403 cap, not the 409 acknowledgement prompt", async () => {
    process.env.NEST_ORG_VISIBILITY = "admins";
    process.env.SHARED_DEPLOYMENT = "true";
    try {
      const r = await setVisibility("org", owner.apiKey, false);
      expect(r.status).toBe(403);
      expect(r.data.code).toBe("visibility_restricted");
    } finally {
      delete process.env.SHARED_DEPLOYMENT;
    }
    expect(await visibilityNow()).toBe("private");
  });

  it("a write collaborator doesn't see context_set_visibility and is refused calling it", async () => {
    const editor = await registerUser(app, "editor@cap.test", "Editor");
    const add = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    expect(add.status).toBe(201);
    const list = await mcp("tools/list", {}, editor.apiKey);
    expect((list?.result?.tools ?? []).map((t: any) => t.name)).not.toContain("context_set_visibility");
    const r = await callTool({ visibility: "public", acknowledge: true }, editor.apiKey);
    expect(r.isError).toBe(true);
    expect(await visibilityNow()).toBe("private");
  });

  it("re-sending the current tier after a concurrent change is a 409, not a silent overwrite", async () => {
    await reset("org");
    const db = getDb();
    // The service reads 'public' (stale); the nest is really 'org'.
    const spy = vi.spyOn(db, "get").mockResolvedValueOnce({ visibility: "public" } as any);
    try {
      const r = await setNestVisibility(nestId, owner.userId, "public", true);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await visibilityNow()).toBe("org");
  });
});

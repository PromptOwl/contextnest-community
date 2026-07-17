/**
 * Scheduled GitHub markdown sync (CU-wdqcpzwf2w).
 *
 * GitHub is a fully in-process mock: `vi.stubGlobal("fetch")` serves the
 * git/trees listing (with ETag / If-None-Match 304s) and raw file contents,
 * so no network. Sweeps run through POST /admin/github-sync/run (the same
 * code path the interval timer calls), and every assertion reads back
 * through the public API so the whole normal service path — node create,
 * versioning, authorship, conflict rule — is exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const ADMIN = "admin@acme.com";
const GITHUB_ENV = [
  "GITHUB_SYNC_TOKEN",
  "GITHUB_SYNC_INTERVAL_MS",
  "GITHUB_SYNC_SOURCES",
  "GITHUB_SYNC_MAX_FILES",
];

// ─── In-process GitHub mock ──────────────────────────────────────────────

interface FakeRepo {
  files: Record<string, string>; // repo path -> raw content
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
/** Root tree sha — derived from the full file map, so any change moves it. */
const treeShaOf = (repo: FakeRepo) => sha(JSON.stringify(repo.files));

const repos: Record<string, FakeRepo> = {};
/** Capture of request headers per URL, for asserting auth/conditional gets. */
const seenHeaders: Array<{ url: string; headers: Record<string, string> }> = [];

function installMockGithub() {
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url);
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    seenHeaders.push({ url, headers });
    const u = new URL(url);
    if (u.hostname !== "api.github.com")
      throw new Error(`unexpected fetch in test: ${url}`);

    // GET /repos/{owner}/{name}/git/trees/{ref}?recursive=1
    let m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^/]+)$/);
    if (m) {
      const repo = repos[m[1]];
      if (!repo) return new Response("{}", { status: 404 });
      const etag = `"${treeShaOf(repo)}"`;
      if (headers["If-None-Match"] === etag)
        return new Response(null, { status: 304, headers: { etag } });
      const tree = Object.entries(repo.files).map(([path, content]) => ({
        path,
        type: "blob",
        sha: sha(content),
      }));
      return new Response(
        JSON.stringify({ sha: treeShaOf(repo), truncated: false, tree }),
        { status: 200, headers: { etag, "content-type": "application/json" } },
      );
    }

    // GET /repos/{owner}/{name}/contents/{path}
    m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
    if (m) {
      const repo = repos[m[1]];
      const path = decodeURIComponent(m[2]);
      const content = repo?.files[path];
      if (content === undefined) return new Response("{}", { status: 404 });
      const etag = `"${sha(content)}"`;
      if (headers["If-None-Match"] === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return new Response(content, { status: 200, headers: { etag } });
    }

    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let admin: { apiKey: string; userId: string; email: string };
let user: { apiKey: string; userId: string; email: string };
let nestId: string;

const runSync = () =>
  jsonRequest(app, "POST", "/admin/github-sync/run", {}, admin.apiKey);
/** GET a node; unwraps the { node } envelope so assertions read data.title. */
const getNode = async (nodeId: string, key = admin.apiKey) => {
  const r = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${nodeId}`,
    undefined,
    key,
  );
  return { status: r.status, data: r.data.node ?? {} };
};
const getVersions = (nodeId: string) =>
  jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${nodeId}/versions`,
    undefined,
    admin.apiKey,
  );

beforeAll(async () => {
  env = setupTestEnv();
  for (const k of GITHUB_ENV) delete process.env[k];
  installMockGithub();
  // ownerEmail makes ADMIN the license admin: allowed to PATCH /admin/settings
  // AND to hit the /admin/github-sync endpoints (same guard as /admin/trace).
  app = await createTestApp("key", { ownerEmail: ADMIN });
  admin = await registerUser(app, ADMIN, "Admin");
  user = await registerUser(app, "user@acme.com", "User");
  const nest = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Synced Docs" },
    admin.apiKey,
  );
  nestId = nest.data.nest.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const k of GITHUB_ENV) delete process.env[k];
  await env.cleanup();
});

describe("settings validation", () => {
  it("rejects a repo that is not owner/name shaped", async () => {
    const res = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_sources: [{ repo: "not-a-repo", nestId }],
    }, admin.apiKey);
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors.github_sync_sources).toMatch(/owner\/name/);
  });

  it("rejects a nonzero interval under 60000 ms", async () => {
    const res = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_interval_ms: 30_000,
    }, admin.apiKey);
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors.github_sync_interval_ms).toMatch(/60000/);
  });

  it("rejects a source pointing at a nest that does not exist", async () => {
    const res = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_sources: [{ repo: "acme/docs", nestId: "nope" }],
    }, admin.apiKey);
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors.github_sync_sources).toMatch(/does not exist/);
  });

  it("accepts a valid config; token is write-only (only presence returns)", async () => {
    const res = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_token: "github_pat_test123",
      github_sync_interval_ms: 0,
      github_sync_sources: [{ repo: "acme/docs", nestId }],
    }, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.settings.github_sync_token_set).toBe(true);
    expect(res.data.settings.github_sync_token).toBeUndefined();
    expect(JSON.stringify(res.data.settings)).not.toContain("github_pat_test123");
    // Normalized on save: default mode applied.
    expect(res.data.settings.github_sync_sources[0].mode).toBe("all-markdown");
  });
});

describe("admin guard", () => {
  it("manual run and status are superadmin-only (403 for a regular user)", async () => {
    const post = await jsonRequest(app, "POST", "/admin/github-sync/run", {}, user.apiKey);
    expect(post.status).toBe(403);
    const get = await jsonRequest(app, "GET", "/admin/github-sync/run", undefined, user.apiKey);
    expect(get.status).toBe(403);
  });
});

describe("all-markdown sweep", () => {
  it("first sweep mirrors every .md, preserving structure, via normal versioning", async () => {
    repos["acme/docs"] = {
      files: {
        "README.md": "# Hello Repo\n\nWelcome to the repo.",
        "docs/setup.md": "# Setup Guide\n\nStep one.",
        "notes.txt": "not markdown — must not sync",
      },
    };
    const res = await runSync();
    expect(res.status).toBe(200);
    expect(res.data.results).toHaveLength(1);
    expect(res.data.results[0].status).toBe("synced");
    expect(res.data.results[0].detail).toContain("2 synced");

    // Auth header carried the configured token.
    const treeReq = seenHeaders.find((h) => h.url.includes("/git/trees/"));
    expect(treeReq?.headers.Authorization).toBe("Bearer github_pat_test123");

    // README.md → nodes/readme, title from the # heading.
    const readme = await getNode("nodes/readme");
    expect(readme.status).toBe(200);
    expect(readme.data.title).toBe("Hello Repo");
    expect(readme.data.content).toContain("Welcome to the repo.");

    // docs/setup.md → nodes/docs/setup (structure preserved).
    const setup = await getNode("nodes/docs/setup");
    expect(setup.status).toBe(200);
    expect(setup.data.title).toBe("Setup Guide");

    // notes.txt did not sync.
    const txt = await getNode("nodes/notes");
    expect(txt.status).toBe(404);

    // Versioned through the normal path: author + changeNote recorded.
    const versions = await getVersions("nodes/docs/setup");
    expect(versions.data.versions.length).toBeGreaterThan(0);
    const v = versions.data.versions[0];
    expect(v.editedBy).toBe("system:github-sync");
    expect(v.changeNote).toContain("Synced from github.com/acme/docs@");
  });

  it("second sweep with an unchanged upstream is a 304 no-op", async () => {
    const before = (await getVersions("nodes/docs/setup")).data.versions.length;
    const res = await runSync();
    expect(res.data.results[0].status).toBe("unchanged");
    expect(res.data.results[0].detail).toMatch(/304/);
    const after = (await getVersions("nodes/docs/setup")).data.versions.length;
    expect(after).toBe(before);
  });

  it("an upstream change re-syncs only the changed file as a new version", async () => {
    const readmeBefore = (await getVersions("nodes/readme")).data.versions.length;
    repos["acme/docs"].files["docs/setup.md"] = "# Setup Guide\n\nStep one.\nStep two.";
    const newShort = treeShaOf(repos["acme/docs"]).slice(0, 7);

    const res = await runSync();
    expect(res.data.results[0].status).toBe("synced");
    expect(res.data.results[0].detail).toContain("1 synced");

    const setup = await getNode("nodes/docs/setup");
    expect(setup.data.content).toContain("Step two.");
    const versions = await getVersions("nodes/docs/setup");
    expect(versions.data.versions[0].changeNote).toBe(
      `Synced from github.com/acme/docs@${newShort}`,
    );
    // README untouched — no phantom versions on unchanged files.
    expect((await getVersions("nodes/readme")).data.versions.length).toBe(readmeBefore);
  });

  it("a locally edited node is never overwritten: local-edits status, content kept", async () => {
    // A human edits the synced doc…
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/docs/setup`,
      { content: "# My Local Truth\n\nHands off." },
      admin.apiKey,
    );
    expect(edit.status).toBe(200);

    // …then upstream changes too.
    repos["acme/docs"].files["docs/setup.md"] = "# Setup Guide\n\nUpstream v3.";
    const res = await runSync();
    expect(res.data.results[0].status).toBe("local-edits");
    expect(res.data.results[0].detail).toMatch(/local edit/);

    const setup = await getNode("nodes/docs/setup");
    expect(setup.data.content).toContain("Hands off.");
    expect(setup.data.content).not.toContain("Upstream v3.");

    // The conflict keeps re-surfacing (etag/head sha deliberately not
    // advanced by a conflicted sweep) instead of being 304'd away.
    const again = await runSync();
    expect(again.data.results[0].status).toBe("local-edits");

    // And the last-run status endpoint reports it.
    const status = await jsonRequest(app, "GET", "/admin/github-sync/run", undefined, admin.apiKey);
    expect(status.status).toBe(200);
    expect(status.data.sources[0].repo).toBe("acme/docs");
    expect(status.data.sources[0].lastStatus).toBe("local-edits");
    expect(status.data.sources[0].lastRunAt).toBeTruthy();
  });

  it("caps the number of files per source and says so", async () => {
    process.env.GITHUB_SYNC_MAX_FILES = "2";
    repos["acme/big"] = {
      files: {
        "a.md": "# A",
        "b.md": "# B",
        "c.md": "# C",
      },
    };
    const patch = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_sources: [{ repo: "acme/big", nestId, folder: "big" }],
    }, admin.apiKey);
    expect(patch.status).toBe(200);

    const res = await runSync();
    expect(res.data.results[0].detail).toContain("truncated to 2 files");
    expect((await getNode("nodes/big/a")).status).toBe(200);
    expect((await getNode("nodes/big/b")).status).toBe(200);
    expect((await getNode("nodes/big/c")).status).toBe(404);
    delete process.env.GITHUB_SYNC_MAX_FILES;
  });

  it("reports upstream deletions without deleting local nodes", async () => {
    delete process.env.GITHUB_SYNC_MAX_FILES;
    delete repos["acme/big"].files["b.md"];
    const res = await runSync();
    expect(res.data.results[0].detail).toMatch(/removed upstream .*1 file/);
    // The node is still there and still serving.
    expect((await getNode("nodes/big/b")).status).toBe(200);
  });
});

describe("single-file mode", () => {
  it("syncs one file with ETag conditional gets", async () => {
    repos["acme/app"] = {
      files: { "README.md": "# App Readme\n\nSingle-file mode." },
    };
    const patch = await jsonRequest(app, "PATCH", "/admin/settings", {
      github_sync_sources: [
        { repo: "acme/app", mode: "single-file", nestId, folder: "readmes" },
      ],
    }, admin.apiKey);
    expect(patch.status).toBe(200);
    // Defaulted path on save.
    expect(patch.data.settings.github_sync_sources[0].path).toBe("README.md");

    const first = await runSync();
    expect(first.data.results[0].status).toBe("synced");
    const node = await getNode("nodes/readmes/readme");
    expect(node.status).toBe(200);
    expect(node.data.title).toBe("App Readme");

    // Unchanged upstream → conditional get → 304 → no new version.
    const before = (await getVersions("nodes/readmes/readme")).data.versions.length;
    const second = await runSync();
    expect(second.data.results[0].status).toBe("unchanged");
    expect(second.data.results[0].detail).toMatch(/304/);
    expect((await getVersions("nodes/readmes/readme")).data.versions.length).toBe(before);

    // Upstream change → new version through the normal path.
    repos["acme/app"].files["README.md"] = "# App Readme\n\nNow with more.";
    const third = await runSync();
    expect(third.data.results[0].status).toBe("synced");
    expect((await getNode("nodes/readmes/readme")).data.content).toContain("Now with more.");
    expect((await getVersions("nodes/readmes/readme")).data.versions[0].editedBy).toBe(
      "system:github-sync",
    );
  });
});

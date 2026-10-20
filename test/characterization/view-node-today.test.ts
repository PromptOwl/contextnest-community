/**
 * Characterization: what a `type: view` node does TODAY (fork 0b2ecf12),
 * before the view feature exists. Pinned against
 * test/characterization/__golden__/view-node-today.json so the developer's
 * change shows up as a deliberate golden diff on view nodes ONLY (the
 * non-view surfaces are pinned separately in view-serving-golden.test.ts and
 * must not move).
 *
 * Two ways a view node can come into being, both recorded:
 *   A. REST create with `type: "view"` — today the engine may not know the
 *      type (unknown types are a clean 400, see unknown-node-type.test.ts).
 *      Whatever status/error comes back is pinned; if it is created, its
 *      read surfaces are pinned too.
 *   B. A view file on disk: create an ordinary document via REST, then
 *      overwrite its file with §1.12-style view frontmatter (a list block and
 *      an html block with data_from) — the way a vault edited outside the
 *      server (ctx / git) would carry one. Its JSON GET, ?format=raw,
 *      ?format=raw&frontmatter=1, /hosted and /hosted?embed=1 are pinned.
 *
 * The block shape below is the brief's description of §1.12; if the spec's
 * exact example differs, swap VIEW_BLOCKS_YAML and re-capture (the read path
 * today is not expected to interpret the blocks at all).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "../helpers.js";
import { Golden, makeNormalizer, sha256, snapResponse, type Normalizer } from "./golden.js";

const NEST_NAME = "Golden View Nest";

// A real table for the list block to point at (fixed content).
const TABLE_TITLE = "Golden Tasks Table";
const TABLE_ID = "nodes/golden-tasks-table";
const TABLE_CSV = "id,title,status\n1,Alpha,open\n2,Beta,done\n3,Gamma,open";

const VIEW_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>View</title></head>' +
  '<body><ul id="out"></ul><script>' +
  'var d = document.getElementById("nest-data");' +
  'document.getElementById("out").textContent = d ? d.textContent : "no data";' +
  "</script></body></html>";

const VIEW_BLOCKS_YAML = [
  "blocks:",
  "  - id: open_tasks",
  "    kind: list",
  `    source: ${TABLE_ID}`,
  '    query: "status = open"',
  "    limit: 10",
  "  - id: board",
  "    kind: html",
  "    data_from:",
  "      - open_tasks",
  "    html: |",
  `      ${VIEW_HTML}`,
].join("\n");

const VIEW_BODY = "# Golden View\n\nA view over the open tasks.";

// Path A
const REST_VIEW_TITLE = "Golden Rest View";
// Path B
const DISK_VIEW_TITLE = "Golden Disk View";
const DISK_VIEW_ID = "nodes/golden-disk-view";
const DISK_VIEW_FILE =
  "---\n" +
  `title: ${DISK_VIEW_TITLE}\n` +
  `id: ${DISK_VIEW_ID}\n` +
  "type: view\n" +
  "tags: []\n" +
  VIEW_BLOCKS_YAML +
  "\n---\n" +
  VIEW_BODY +
  "\n";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;
let norm: Normalizer;
let restCreate: { status: number; data: any };
const golden = new Golden("view-node-today");

async function get(path: string) {
  return app.request(path, { headers: authed(owner.apiKey) });
}

async function stableSnap(path: string) {
  const a = await snapResponse(await get(path), norm);
  const b = await snapResponse(await get(path), norm);
  expect(b.snap, `non-deterministic response for ${path}`).toEqual(a.snap);
  return a;
}

/** Shape of the node JSON GET, reduced to what is stable and meaningful. */
async function jsonGetSnap(nodeId: string) {
  const res = await get(`/nests/${nestId}/nodes/${nodeId}`);
  const status = res.status;
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON is itself the pinned fact */
  }
  const node = data?.node;
  return {
    status,
    topLevelKeys: data && typeof data === "object" ? Object.keys(data).sort() : null,
    nodeKeys: node && typeof node === "object" ? Object.keys(node).sort() : null,
    type: node?.type ?? null,
    title: node?.title ?? null,
    contentSha256: typeof node?.content === "string" ? sha256(norm(node.content)) : null,
    contentHasNestData:
      typeof node?.content === "string" ? node.content.includes('id="nest-data"') : null,
    error: data?.error != null ? norm(String(data.error)) : null,
    code: data?.code ?? null,
  };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@golden-view.test", "Golden View Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: NEST_NAME }, owner.apiKey);
  expect(nest.status).toBe(201);
  nestId = nest.data.nest.id;
  norm = makeNormalizer({ NEST_ID: nestId, OWNER_ID: owner.userId });

  const table = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: TABLE_TITLE, content: TABLE_CSV, type: "table" },
    owner.apiKey,
  );
  expect(table.status).toBe(201);
  expect(table.data.node.id).toBe(TABLE_ID);

  // Path A — REST create with type "view".
  restCreate = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: REST_VIEW_TITLE, content: VIEW_BODY, type: "view" },
    owner.apiKey,
  );

  // Path B — ordinary document, then its file becomes a view on disk.
  const doc = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: DISK_VIEW_TITLE, content: "# placeholder" },
    owner.apiKey,
  );
  expect(doc.status).toBe(201);
  expect(doc.data.node.id).toBe(DISK_VIEW_ID);
  writeFileSync(
    join(env.dataDir, "nests", nestId, "nodes", "golden-disk-view.md"),
    DISK_VIEW_FILE,
  );
});

afterAll(async () => {
  golden.flush();
  await env.cleanup();
});

describe("type: view via REST create (path A)", () => {
  it("pins the create response", () => {
    golden.check("A create", {
      status: restCreate.status,
      nodeId: restCreate.data?.node?.id ?? null,
      nodeType: restCreate.data?.node?.type ?? null,
      error: restCreate.data?.error != null ? norm(String(restCreate.data.error)) : null,
    });
  });

  it("pins the read surfaces when (and only when) it was created", async () => {
    if (restCreate.status !== 201) {
      // Not creatable today: the golden above (status + error) is the pin.
      golden.check("A reads", null);
      return;
    }
    const id = restCreate.data.node.id as string;
    const base = `/nests/${nestId}/nodes/${id}`;
    const reads = {
      json: await jsonGetSnap(id),
      raw: (await stableSnap(`${base}?format=raw`)).snap,
      rawFrontmatter: (await stableSnap(`${base}?format=raw&frontmatter=1`)).snap,
      hosted: (await stableSnap(`${base}/hosted`)).snap,
    };
    golden.check("A reads", reads);
  });
});

describe("type: view file on disk (path B)", () => {
  const base = () => `/nests/${nestId}/nodes/${DISK_VIEW_ID}`;

  it("node JSON GET", async () => {
    const snap = await jsonGetSnap(DISK_VIEW_ID);
    // Today nothing injects data into a node's JSON content.
    if (snap.contentHasNestData !== null) expect(snap.contentHasNestData).toBe(false);
    golden.check("B json GET", snap);
  });

  it("?format=raw", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw`);
    expect(body).not.toContain('id="nest-data"');
    golden.check("B ?format=raw", snap);
  });

  it("?format=raw&frontmatter=1", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw&frontmatter=1`);
    expect(body).not.toContain('id="nest-data"');
    golden.check("B ?format=raw&frontmatter=1", snap);
  });

  it("/hosted", async () => {
    const { snap, body } = await stableSnap(`${base()}/hosted`);
    expect(body).not.toContain('id="nest-data"');
    golden.check("B /hosted", snap);
  });

  it("/hosted?embed=1", async () => {
    const { snap, body } = await stableSnap(`${base()}/hosted?embed=1`);
    expect(body).not.toContain('id="nest-data"');
    golden.check("B /hosted?embed=1", snap);
  });
});

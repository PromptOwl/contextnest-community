/**
 * MCP `structuredContent` ↔ engine operation-catalog conformance.
 *
 * The earlier phases of this effort taught nine tools to emit the operation
 * catalog's JSON payloads as `structuredContent`, so the `ctx` CLI can drive
 * this server. Nothing stopped those payloads from quietly drifting apart
 * again — and an undetected divergence between the two surfaces is exactly
 * what opened the gap in the first place. This is the guard.
 *
 * Each tool is called over the real MCP transport and its `structuredContent`
 * is checked against `getOperation(<name>).output` — the zod schema the engine
 * publishes for that operation. Two checks, because one is not enough:
 *
 *   1. `safeParse` — catches a missing required field, a wrong type, or a
 *      value outside an enum.
 *   2. an unknown-key walk over `outputJsonSchema(op)` — catches fields this
 *      server ADDS. Zod objects strip unknown keys by default, so `parse`
 *      alone is blind to an added field even though the published JSON Schema
 *      says `additionalProperties: false`.
 *
 * Every real divergence is recorded below as an individually-named exception
 * with the reason this server is right. The list is exact in BOTH directions:
 * an unlisted mismatch fails the test, and a listed one that stops happening
 * fails it too — so when upstream widens a schema, the test says so instead of
 * suppressing it forever.
 *
 * NOT a place to "fix" a handler. Several omissions here are security
 * decisions (see the `body` / `source_nodes` notes); making them conform would
 * reintroduce a data leak.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getOperation,
  outputJsonSchema,
  type OperationDescriptor,
} from "@promptowl/contextnest-engine/api";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let rpcId = 1;

/** One tools/call over the per-nest MCP endpoint → the full CallToolResult
 *  (not just the prose, which is what test/mcp-routes.test.ts wants). */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()).result;
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length)).result;
}

// ─── conformance machinery ──────────────────────────────────────────────

/** Path segments → a stable string. Array indices collapse to `[]` so a
 *  signature names a FIELD, not "whichever document happened to be 4th". */
function fmtPath(path: (string | number)[]): string {
  return path
    .map((s) => (typeof s === "number" ? "[]" : `.${s}`))
    .join("")
    .replace(/^\./, "");
}

/** Keys present in the payload that the catalog schema does not declare.
 *
 *  ponytail: reads `properties`/`items` only — enough for every current
 *  catalog output shape. Teach it `anyOf`/`$ref` if the catalog grows them. */
function unknownKeys(value: any, schema: any, path: string): string[] {
  if (!schema || value == null) return [];
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    for (const v of value)
      for (const k of unknownKeys(v, schema.items, `${path}[]`)) seen.add(k);
    return [...seen];
  }
  if (typeof value !== "object" || !schema.properties) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (!(k in schema.properties)) out.push(here);
    else out.push(...unknownKeys(v, schema.properties[k], here));
  }
  return out;
}

/** Every way this payload disagrees with the catalog, as stable signatures. */
function divergences(payload: unknown, op: OperationDescriptor): string[] {
  const parsed = op.output.safeParse(payload);
  const fromZod = parsed.success
    ? []
    : parsed.error.issues.map(
        (i: any) =>
          `${i.code}(${i.received ?? i.expected})` + ` at ${fmtPath(i.path)}`,
      );
  const fromKeys = unknownKeys(
    payload,
    outputJsonSchema(op) as any,
    "",
  ).map((k) => `unknown_key at ${k}`);
  return [...new Set([...fromZod, ...fromKeys])];
}

// ─── the tools, in call order ───────────────────────────────────────────

interface Case {
  tool: string;
  args?: Record<string, unknown>;
  /** Catalog operation name. Omitted = this server has no catalog entry to
   *  conform to; `local` asserts the shape instead. */
  catalog?: string;
  /** Documented divergence signature → why this server is right to diverge. */
  allowed?: Record<string, string>;
  /** Shape assertion for a tool with no catalog entry. */
  local?: (payload: any) => void;
}

const TYPE_ENUM =
  "the engine's NODE_TYPES enum has no such member; this server ships it as a " +
  "first-class node type through REST/UI/MCP. GENUINE DISAGREEMENT — needs an " +
  "upstream decision (widen NODE_TYPES, or stop serving the type), not a test " +
  "suppression.";

const CASES: Case[] = [
  {
    // Create must run first — later cases address the node it makes.
    tool: "context_create",
    args: { title: "Conformance Doc", content: "# Conformance\n\nfirst body." },
    catalog: "context_create",
    allowed: {
      "unknown_key at status":
        "where the write landed — a draft awaiting steward review under " +
        "stewardship, auto-published on a nest with no stewards. The catalog " +
        "has no field for it and a caller cannot infer it. Additive, so a " +
        "catalog-only reader is unaffected.",
      "unknown_key at checkpoint":
        "explicitly null: this server seals nothing. A write goes live through " +
        "steward review, not a checkpoint. Saying so beats staying silent.",
    },
  },
  {
    tool: "context_update",
    args: { title: "Conformance Doc", content: "# Conformance\n\nsecond body." },
    catalog: "context_update",
    allowed: {
      "unknown_key at status": "same as context_create.",
      "unknown_key at checkpoint": "same as context_create.",
    },
  },
  {
    tool: "context_list",
    catalog: "context_list",
    allowed: {
      [`invalid_enum_value(table) at documents[].type`]: TYPE_ENUM,
      [`invalid_enum_value(agent) at documents[].type`]: TYPE_ENUM,
      [`invalid_enum_value(external_edit_pending) at documents[].status`]:
        "a real workflow state this server computes (a document edited on disk " +
        "behind the API, awaiting reconciliation) and already reports through " +
        "REST and the UI. Outside the engine's STATUSES enum. GENUINE " +
        "DISAGREEMENT — needs an upstream decision, not a test suppression.",
    },
    // No `body` on the listed documents, and that is deliberate:
    // listNodesForCaller gates WHICH documents come back but not the text they
    // carry, which under stewardship is the unapproved draft resolveLlmBody
    // refuses to serve. The catalog makes body optional, so omitting it
    // conforms — it needs no exception, and adding one would be a data leak.
  },
  {
    tool: "context_get",
    args: { title: "API Reference" },
    catalog: "context_get",
    // Clean. `raw` is absent because the catalog never had it — this server has
    // no include_raw input and never served the stored bytes here.
  },
  {
    // Matches the table node, so the type divergence is checked on this
    // surface too rather than only on list/query.
    tool: "context_search",
    args: { query: "deal" },
    catalog: "context_search",
    allowed: { [`invalid_enum_value(table) at results[].type`]: TYPE_ENUM },
    // No `score`: this is a term-containment filter, not a ranked search, and
    // the catalog makes score optional. Conforms as-is.
  },
  {
    tool: "context_query",
    args: { query: "#api" },
    catalog: "context_query",
    allowed: { [`invalid_enum_value(table) at documents[].type`]: TYPE_ENUM },
    // `source_nodes` is absent for the same security reason context_list omits
    // `body`: the handler never gates result.sourceNodes, so serving them
    // structurally would hand out content the prose path refuses. Optional in
    // the catalog, so this conforms.
  },
  {
    tool: "context_versions",
    args: { title: "Conformance Doc" },
    catalog: "context_versions",
    allowed: {
      "invalid_type(undefined) at keyframe_interval":
        "there is no keyframe+diff model here — version bodies live on disk and " +
        "in the DB, not as keyframes plus diffs. The catalog makes this REQUIRED. " +
        "GENUINE DISAGREEMENT — either the catalog relaxes it or this server " +
        "grows a keyframe model; a faked constant would be a lie.",
      "invalid_type(undefined) at versions[].keyframe":
        "same missing model — no version here is a keyframe.",
      "invalid_type(undefined) at versions[].content_hash":
        "the column exists but is conflict-detection state this tool has never " +
        "served, and it is ungated. Required in the catalog.",
      "invalid_type(undefined) at versions[].chain_hash":
        "integrity here is server-side, not a per-version hash chain. Required " +
        "in the catalog.",
      "unknown_key at approved_version":
        "which version AI traffic is actually served — the community equivalent " +
        "of the catalog's publish state, and the same fact the prose reports.",
      "unknown_key at versions[].status":
        "per-version lifecycle state (draft/pending/published). The catalog " +
        "models publication as `published_at`, which this server has no " +
        "equivalent for; status is what it does have.",
    },
  },
  {
    tool: "context_submit_review",
    args: { title: "Conformance Doc" },
    // No `catalog`: context_submit_review is a governance-namespace operation,
    // and that namespace is declared-but-unimplemented upstream — there is no
    // descriptor to conform to. The `local` shape below is this server's own
    // contract. The assertion that getOperation() still returns undefined is
    // deliberate: when the engine does implement governance, this test fails
    // and tells you to switch this row to catalog conformance.
    local: (d) => {
      expect(d).toMatchObject({
        id: expect.any(String),
        submitted: true,
        review: {
          id: expect.any(String),
          version: expect.any(Number),
          status: expect.any(String),
          priority: expect.any(String),
          requested_by: expect.any(String),
          requested_at: expect.any(String),
        },
        reviewers: expect.any(Array),
      });
      // No top-level version/checkpoint: this operation writes no new version
      // and seals no checkpoint, it points a review request at the version
      // that already existed.
      expect(Object.keys(d).sort()).toEqual(["id", "review", "reviewers", "submitted"]);
    },
  },
  {
    // Last — it removes the node the rows above address.
    tool: "context_delete",
    args: { title: "Conformance Doc" },
    catalog: "context_delete",
    allowed: {
      "unknown_key at title":
        "echoes back what was deleted so a title-addressed caller can confirm " +
        "it hit the right node. Additive only.",
    },
  },
];

// ─── fixture ────────────────────────────────────────────────────────────

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const create = await jsonRequest(app, "POST", "/nests", {
    name: "Catalog Conformance Nest",
  });
  nestId = create.data.nest.id;

  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "API Reference",
    content: "# API\n\nDocumentation for the public API.",
    tags: ["api", "docs"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Architecture Overview",
    content: "# Architecture\n\nSystem-level design notes.",
    tags: ["architecture", "api"],
  });
  // Two node types this server ships that the engine's NODE_TYPES enum does
  // not know. Seeded on purpose: without them the type divergence is invisible
  // and the conformance report reads cleaner than reality.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Deal Table",
    content: "# Deals\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    tags: ["api"],
    type: "table",
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Nightly Agent",
    content: "# Agent\n\nRuns things on a schedule.",
    type: "agent",
  });

  // A document edited on disk behind the API's back, then staged as drift —
  // the only way to produce `status: "external_edit_pending"`, which is the
  // out-of-enum status context_list reports.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Drifted Doc",
    content: "# Drifted\n\noriginal body.",
  });
  const mdPath = join(
    process.env.DATA_ROOT!,
    "nests",
    nestId,
    "nodes",
    "drifted-doc.md",
  );
  expect(existsSync(mdPath), `vault layout changed: ${mdPath}`).toBe(true);
  writeFileSync(
    mdPath,
    readFileSync(mdPath, "utf-8").replace(
      "original body.",
      "edited outside the app entirely.",
    ),
    "utf-8",
  );
  const scan = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/external-edits/scan`,
  );
  expect(scan.data.staged, "drift fixture staged nothing").toBe(1);
});

afterAll(() => env.cleanup());

// ─── the guard ──────────────────────────────────────────────────────────

describe("MCP structuredContent conforms to the engine operation catalog", () => {
  // Sequential, not it.each: later cases address the node earlier ones write.
  it("every converted tool matches its catalog schema, divergences and all", async () => {
    for (const c of CASES) {
      const result = await callTool(c.tool, c.args);
      const payload = result.structuredContent;
      expect(payload, `${c.tool} emitted no structuredContent`).toBeDefined();

      if (!c.catalog) {
        expect(
          getOperation(c.tool),
          `${c.tool} is now in the catalog — replace its local shape assertion ` +
            `with catalog conformance`,
        ).toBeUndefined();
        c.local!(payload);
        continue;
      }

      const op = getOperation(c.catalog);
      expect(op, `no catalog operation named ${c.catalog}`).toBeDefined();

      const observed = divergences(payload, op!);
      const allowed = c.allowed ?? {};

      expect(
        observed.filter((s) => !(s in allowed)).sort(),
        `${c.tool}: undocumented divergence from the catalog. Either the ` +
          `handler regressed, or this is a new deliberate divergence — add it ` +
          `to that case's \`allowed\` map WITH the reason it is correct. ` +
          `Never widen the schema.`,
      ).toEqual([]);

      expect(
        Object.keys(allowed).filter((s) => !observed.includes(s)).sort(),
        `${c.tool}: documented divergence no longer happens. If upstream fixed ` +
          `it, delete the entry; if the fixture stopped producing the case, ` +
          `restore it.`,
      ).toEqual([]);
    }
  });
});

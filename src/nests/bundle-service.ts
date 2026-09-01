/**
 * Nest export — package a nest's documents as a .zip that the EXISTING folder
 * importer (POST /nests/import) ingests on any ContextNest host. No separate
 * import path: unzip the bundle and feed the files to /nests/import like any
 * picked folder (the UI does this client-side).
 *
 * Each document is serialized from its PUBLISHED/APPROVED state (approved body,
 * `status: published`) so it re-imports as published rather than an unpublished
 * draft. Unapproved DRAFT documents are included only when `includeDrafts` is
 * set — otherwise the export is approved/published content only.
 *
 * What does NOT travel: identities/attribution and the governance overlay
 * (stewards, reviews, comments, definitions, edges, grants). The importer owns
 * and re-governs the fresh nest.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep } from "path";
import JSZip from "jszip";
import { getDb } from "../db/client.js";
import { serializeDocument } from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import { resolveExportBody } from "../nodes/readable-body.js";
import { resolveNestPath } from "../shared/paths.js";
import { stripUndefinedDeep } from "../governance/safe-publish.js";
import { trackEvent } from "../telemetry/tracker.js";

/** Every file under `root`, as forward-slash relative paths. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return out; // nest folder missing/unreadable — nothing to add
  }
  for (const rel of entries) {
    try {
      if (statSync(join(root, rel)).isFile()) out.push(rel.split(sep).join("/"));
    } catch {
      // race with a concurrent delete — skip
    }
  }
  return out;
}

/**
 * Build the export .zip for a nest. Caller must have already gated the request
 * (any nest reader — viewer and up). `includeDrafts` adds unapproved draft
 * documents; when false, only approved/published documents are exported.
 */
export async function exportNestBundle(
  nestId: string,
  includeDrafts: boolean,
): Promise<ArrayBuffer> {
  const db = getDb();
  const approvedRows = (await db.all(
    "SELECT node_id, approved_version FROM approved_versions WHERE nest_id = ?",
    [nestId],
  )) as Array<{ node_id: string; approved_version: number }>;
  const approvedByNode = new Map(
    approvedRows.map((r) => [r.node_id, r.approved_version]),
  );

  const { storage } = await engineCache.get(nestId);
  const docs = await storage.discoverDocuments();

  const zip = new JSZip();
  let count = 0;
  for (const doc of docs) {
    const approved = approvedByNode.get(doc.id);
    // Drop undefined frontmatter values (e.g. `tags: undefined` on a tagless
    // doc) — the YAML dumper throws on them, same guard serializeNodeSafe uses.
    const frontmatter = stripUndefinedDeep({ ...doc.frontmatter }) as typeof doc.frontmatter;
    let body = doc.body || "";
    if (approved != null) {
      // Published/approved node: ship the APPROVED bytes as `status: published`.
      // The raw on-disk working copy can carry `status: draft` + a bumped
      // version even for a governance-published node, which would re-import as
      // an unpublished draft — so we override status/version/body here.
      const approvedBody = await resolveExportBody(nestId, doc.id, body);
      // null = the approved version couldn't be reconstructed. Do NOT fall back
      // to the working copy — that would ship unapproved bytes stamped
      // `status: published`, exactly what the approved-only export prevents.
      // Skip the doc instead (it's dropped from this export).
      if (approvedBody == null) continue;
      body = approvedBody;
      frontmatter.status = "published";
      frontmatter.version = approved;
    } else {
      // No approved version → an unapproved draft. Skip unless opted in.
      if (!includeDrafts) continue;
      frontmatter.status = "draft";
    }
    zip.file(`${doc.id}.md`, serializeDocument({ ...doc, frontmatter, body }));
    count++;
  }

  // Ship the engine's on-disk sidecars verbatim so version history + nest config
  // travel with the content:
  //   - `.versions/**` — keyframes + history the engine reconstructs older
  //     versions from (under the nest root and under nodes/).
  //   - `.context/config.yaml` — the nest's non-identity config only.
  //   - `CONTEXT.md`.
  // Node .md files are serialized above from their approved state, so these
  // never collide with them; the importer copies them untouched.
  //
  // SECURITY: only `.context/config.yaml` is whitelisted — NOT the whole
  // `.context/**`. That directory can also hold `.context/stewards.yaml`
  // (steward emails + roles); shipping it would leak the source host's people
  // AND let the destination activate them by email via `stewards/sync`. People
  // and governance must never travel (see the export design). Any new identity
  // file under `.context` stays excluded by this allowlist by default.
  //
  // ENGINE BOUNDARY (see CLAUDE.md): this reaches into the engine's private
  // on-disk `.versions` layout directly. A future engine storage-format change
  // would break exports with no compile-time signal — track replacing this with
  // an engine-exported "export version history" API upstream.
  const nestPath = resolveNestPath(nestId);
  for (const rel of walkFiles(nestPath)) {
    const segs = rel.split("/");
    const keep =
      segs.includes(".versions") ||
      rel === ".context/config.yaml" ||
      rel === "CONTEXT.md";
    if (!keep) continue;
    zip.file(rel, readFileSync(join(nestPath, rel)));
  }

  trackEvent("nest.export.bundle", { nestId, documents: count, includeDrafts });
  return zip.generateAsync({ type: "arraybuffer" });
}

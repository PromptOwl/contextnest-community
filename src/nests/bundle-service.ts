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
 * (owner/admin). `includeDrafts` adds unapproved draft documents; when false,
 * only approved/published documents are exported.
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
    // doc) — the YAML dumper throws on them, same guard as safePublishDocument.
    const frontmatter = stripUndefinedDeep({ ...doc.frontmatter }) as typeof doc.frontmatter;
    let body = doc.body || "";
    if (approved != null) {
      // Published/approved node: ship the APPROVED bytes as `status: published`.
      // The raw on-disk working copy can carry `status: draft` + a bumped
      // version even for a governance-published node, which would re-import as
      // an unpublished draft — so we override status/version/body here.
      body = (await resolveExportBody(nestId, doc.id, body)) ?? body;
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

  // Ship the engine's on-disk sidecars verbatim so the version history and nest
  // config travel with the content: `.versions/**` (keyframes + history the
  // engine reconstructs older versions from — under the nest root and under
  // nodes/), `.context/**` (config.yaml), and CONTEXT.md. Node .md files are
  // serialized above from their approved state, so these never collide with
  // them. The importer copies them to the new nest folder untouched.
  const nestPath = resolveNestPath(nestId);
  for (const rel of walkFiles(nestPath)) {
    const segs = rel.split("/");
    const keep =
      segs.includes(".versions") || segs[0] === ".context" || rel === "CONTEXT.md";
    if (!keep) continue;
    zip.file(rel, readFileSync(join(nestPath, rel)));
  }

  trackEvent("nest.export.bundle", { nestId, documents: count, includeDrafts });
  return zip.generateAsync({ type: "arraybuffer" });
}

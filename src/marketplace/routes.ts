/**
 * Marketplace — packs ARE nests. No parallel registry service, no second
 * codebase: publishing flags an existing nest as a pack; browsing lists
 * those nests; installing copies the pack's documents into a fresh nest
 * for the caller via the same import path the UI's Import Folder uses.
 *
 * Pricing rides pack_meta (credits); consumption is metered through the
 * existing telemetry channel to PromptOwl (meter.pack_install here,
 * meter.context_call in query-routes), where the credit ledger lives.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { importNest } from "../nests/service.js";
import { registerImportedDocuments } from "../nodes/service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import { trackEvent, trackMeterEvent } from "../telemetry/tracker.js";
import type { ContextNode } from "@promptowl/contextnest-engine";

export const marketplaceRoutes = new Hono<AuthEnv>();

export interface PackMeta {
  version: string;
  summary: string;
  price_credits_install: number;
  price_credits_per_call: number;
}

interface PackRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  pack_meta: string | null;
  created_at: string;
}

function parseMeta(raw: string | null): PackMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackMeta;
  } catch {
    return null;
  }
}

/** Rebuild the on-disk file for a document so install reuses importNest
 *  verbatim — the same byte path as the UI's Import Folder. */
function docToFile(doc: ContextNode): { path: string; content: string } {
  const fm = (doc.frontmatter || {}) as unknown as Record<string, unknown>;
  const lines = ["---"];
  for (const key of ["title", "type", "status", "trigger"]) {
    const v = fm[key];
    if (v != null && v !== "") lines.push(`${key}: ${JSON.stringify(v)}`);
  }
  const tags = (fm.tags as string[] | undefined) ?? [];
  if (tags.length > 0) {
    lines.push(`tags: [${tags.map((t) => JSON.stringify(String(t).replace(/^#/, ""))).join(", ")}]`);
  }
  lines.push("---", "");
  return { path: `${doc.id}.md`, content: lines.join("\n") + (doc.body || "") };
}

// GET /marketplace/packs — browse. Public packs only; listing data, no bodies.
marketplaceRoutes.get("/packs", async (c) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, slug, description, pack_meta, created_at
         FROM nests WHERE is_pack = 1 AND visibility = 'public'
        ORDER BY name`,
    )
    .all() as PackRow[];
  const packs = rows.map((r) => {
    const docCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM node_versions WHERE nest_id = ? AND version = 1")
        .get(r.id) as { c: number }
    ).c;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      summary: parseMeta(r.pack_meta)?.summary ?? r.description ?? "",
      version: parseMeta(r.pack_meta)?.version ?? "0.0.0",
      price_credits_install: parseMeta(r.pack_meta)?.price_credits_install ?? 0,
      price_credits_per_call: parseMeta(r.pack_meta)?.price_credits_per_call ?? 0,
      doc_count: docCount,
      published_at: r.created_at,
    };
  });
  return c.json({ count: packs.length, packs });
});

// POST /marketplace/publish/:nestId — owner/admin publishes a nest as a pack.
marketplaceRoutes.post("/publish/:nestId", async (c) => {
  const nestId = c.req.param("nestId");
  const userId = c.get("userId");
  const permission = resolveNestPermission(nestId, userId);
  if (permissionLevel(permission) < permissionLevel("admin")) {
    throw new ForbiddenError("Only the nest owner or an admin can publish it as a pack.");
  }

  const body = await c.req.json<Partial<PackMeta>>().catch(() => ({}) as Partial<PackMeta>);
  if (!body.summary || typeof body.summary !== "string") {
    throw new ValidationError("summary is required");
  }
  const meta: PackMeta = {
    version: typeof body.version === "string" ? body.version : "0.1.0",
    summary: body.summary,
    price_credits_install: Math.max(0, Number(body.price_credits_install) || 0),
    price_credits_per_call: Math.max(0, Number(body.price_credits_per_call) || 0),
  };

  const db = getDb();
  const exists = db.prepare("SELECT id FROM nests WHERE id = ?").get(nestId);
  if (!exists) throw new NotFoundError(`Nest not found: ${nestId}`);
  // Publishing implies public browse — a pack nobody can see isn't a pack.
  db.prepare(
    "UPDATE nests SET is_pack = 1, pack_meta = ?, visibility = 'public' WHERE id = ?",
  ).run(JSON.stringify(meta), nestId);

  trackEvent("marketplace.publish", { nestId, version: meta.version });
  return c.json({ ok: true, pack: { id: nestId, ...meta } });
});

// POST /marketplace/unpublish/:nestId — owner/admin delists (nest survives).
marketplaceRoutes.post("/unpublish/:nestId", async (c) => {
  const nestId = c.req.param("nestId");
  const userId = c.get("userId");
  const permission = resolveNestPermission(nestId, userId);
  if (permissionLevel(permission) < permissionLevel("admin")) {
    throw new ForbiddenError("Only the nest owner or an admin can unpublish it.");
  }
  getDb().prepare("UPDATE nests SET is_pack = 0 WHERE id = ?").run(nestId);
  trackEvent("marketplace.unpublish", { nestId });
  return c.json({ ok: true });
});

// POST /marketplace/install/:packId — copy the pack into a fresh nest owned
// by the caller. Emits meter.pack_install with the credit price so the
// PromptOwl ledger can debit; the community server never touches money.
marketplaceRoutes.post("/install/:packId", async (c) => {
  const packId = c.req.param("packId");
  const userId = c.get("userId");
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, name, pack_meta FROM nests WHERE id = ? AND is_pack = 1 AND visibility = 'public'",
    )
    .get(packId) as { id: string; name: string; pack_meta: string | null } | undefined;
  if (!row) throw new NotFoundError(`Pack not found: ${packId}`);
  const meta = parseMeta(row.pack_meta);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name?.trim() || row.name;

  const { storage } = engineCache.get(packId);
  const documents = await storage.discoverDocuments();
  const files = documents.map(docToFile);

  const nest = await importNest(userId, name, files);
  await registerImportedDocuments(nest.id, resolveCallerEmail(userId));
  db.prepare("UPDATE nests SET installed_from_pack = ? WHERE id = ?").run(
    packId,
    nest.id,
  );

  trackMeterEvent("meter.pack_install", {
    pack_id: packId,
    pack_version: meta?.version ?? "0.0.0",
    nest_id: nest.id,
    price_credits_install: meta?.price_credits_install ?? 0,
    doc_count: files.length,
  });
  return c.json({ ok: true, nest: { ...nest, installed_from_pack: packId } }, 201);
});

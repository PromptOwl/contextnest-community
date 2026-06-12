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
import { isLicenseAdminUserId } from "../auth/license.js";
import { config } from "../config.js";
import {
  fetchRegistryPacks,
  fetchRegistryPackFiles,
} from "./registry.js";
import type { ContextNode } from "@promptowl/contextnest-engine";

export const marketplaceRoutes = new Hono<AuthEnv>();

export interface PackMeta {
  version: string;
  summary: string;
  price_credits_install: number;
  price_credits_per_call: number;
  /** Moderation gate. Creators (e.g. via `ctx push` + the publish API)
   *  land as 'pending'; only the license admin — on a PromptOwl-operated
   *  marketplace server that IS PromptOwl — approves into the public
   *  listing. Admin self-publishes go straight to 'approved'. */
  status: "pending" | "approved" | "rejected";
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
  // Only approved packs list publicly. Legacy metas without a status field
  // (pre-moderation listings) read as approved.
  const approved = rows.filter(
    (r) => (parseMeta(r.pack_meta)?.status ?? "approved") === "approved",
  );
  const packs = approved.map((r) => {
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
      source: "local" as "local" | "registry",
    };
  });

  // Central registry packs (best-effort; a dead registry never breaks the
  // local store). Local listings win id collisions.
  const registryUrl = config.MARKETPLACE_REGISTRY_URL;
  if (registryUrl) {
    const localIds = new Set(packs.map((p) => p.id));
    const remote = await fetchRegistryPacks(registryUrl);
    for (const p of remote) {
      if (!localIds.has(p.id)) {
        packs.push({ ...p, source: "registry" as const });
      }
    }
  }

  return c.json({ count: packs.length, packs });
});

// GET /marketplace/packs/:packId/files — a pack's importable files, for
// CROSS-SERVER installs (another community server pulls these and imports
// locally). Approved packs only; same rebuilt-file path as local install.
marketplaceRoutes.get("/packs/:packId/files", async (c) => {
  const packId = c.req.param("packId");
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, name, pack_meta FROM nests WHERE id = ? AND is_pack = 1 AND visibility = 'public'",
    )
    .get(packId) as { id: string; name: string; pack_meta: string | null } | undefined;
  const meta = row ? parseMeta(row.pack_meta) : null;
  if (!row || (meta?.status ?? "approved") !== "approved") {
    throw new NotFoundError(`Pack not found: ${packId}`);
  }
  const { storage } = engineCache.get(packId);
  const documents = await storage.discoverDocuments();
  return c.json({
    pack: { id: row.id, name: row.name, ...(meta ?? {}) },
    files: documents.map(docToFile),
  });
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
  // Moderation: creator publishes land pending; the license admin (on a
  // PromptOwl-operated server, that IS PromptOwl) is auto-approved.
  const autoApproved = isLicenseAdminUserId(userId);
  const meta: PackMeta = {
    version: typeof body.version === "string" ? body.version : "0.1.0",
    summary: body.summary,
    price_credits_install: Math.max(0, Number(body.price_credits_install) || 0),
    price_credits_per_call: Math.max(0, Number(body.price_credits_per_call) || 0),
    status: autoApproved ? "approved" : "pending",
  };

  const db = getDb();
  const exists = db.prepare("SELECT id FROM nests WHERE id = ?").get(nestId);
  if (!exists) throw new NotFoundError(`Nest not found: ${nestId}`);
  // Publishing implies public browse — a pack nobody can see isn't a pack.
  db.prepare(
    "UPDATE nests SET is_pack = 1, pack_meta = ?, visibility = 'public' WHERE id = ?",
  ).run(JSON.stringify(meta), nestId);

  trackEvent("marketplace.publish", {
    nestId,
    version: meta.version,
    status: meta.status,
  });
  return c.json({ ok: true, pack: { id: nestId, ...meta } });
});

// GET /marketplace/pending — the moderation queue (license-admin only).
marketplaceRoutes.get("/pending", async (c) => {
  const userId = c.get("userId");
  if (!isLicenseAdminUserId(userId)) {
    throw new ForbiddenError("Only the marketplace operator can view the approval queue.");
  }
  const rows = getDb()
    .prepare(
      "SELECT id, name, slug, pack_meta, created_at FROM nests WHERE is_pack = 1 ORDER BY created_at DESC",
    )
    .all() as PackRow[];
  const pending = rows
    .map((r) => ({ row: r, meta: parseMeta(r.pack_meta) }))
    .filter((x) => x.meta?.status === "pending")
    .map((x) => ({ id: x.row.id, name: x.row.name, ...x.meta }));
  return c.json({ count: pending.length, pending });
});

// POST /marketplace/review/:nestId — approve or reject a pending pack
// (license-admin only). Rejection keeps the nest; it just never lists.
marketplaceRoutes.post("/review/:nestId", async (c) => {
  const userId = c.get("userId");
  if (!isLicenseAdminUserId(userId)) {
    throw new ForbiddenError("Only the marketplace operator can review packs.");
  }
  const body = await c.req
    .json<{ decision?: "approved" | "rejected" }>()
    .catch(() => ({}) as { decision?: "approved" | "rejected" });
  if (body.decision !== "approved" && body.decision !== "rejected") {
    throw new ValidationError("decision must be 'approved' or 'rejected'");
  }
  const nestId = c.req.param("nestId");
  const db = getDb();
  const row = db
    .prepare("SELECT pack_meta FROM nests WHERE id = ? AND is_pack = 1")
    .get(nestId) as { pack_meta: string | null } | undefined;
  if (!row) throw new NotFoundError(`Pack not found: ${nestId}`);
  const meta = parseMeta(row.pack_meta);
  if (!meta) throw new ValidationError("Pack has no manifest to review.");
  meta.status = body.decision;
  db.prepare("UPDATE nests SET pack_meta = ? WHERE id = ?").run(
    JSON.stringify(meta),
    nestId,
  );
  trackEvent("marketplace.review", { nestId, decision: body.decision });
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
  if ((meta?.status ?? "approved") !== "approved") {
    throw new NotFoundError(`Pack not found: ${packId}`);
  }

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name?.trim() || row.name;

  const { storage } = engineCache.get(packId);
  const documents = await storage.discoverDocuments();
  const files = documents.map(docToFile);

  const nest = await importNest(userId, name, files);
  await registerImportedDocuments(nest.id, resolveCallerEmail(userId));
  // Provenance + a copy of the pricing meta: the installed copy carries its
  // own meter rates, so metering keeps working even if the source pack is
  // delisted (or, for registry installs below, lives on another server).
  db.prepare(
    "UPDATE nests SET installed_from_pack = ?, pack_meta = ? WHERE id = ?",
  ).run(packId, row.pack_meta, nest.id);

  trackMeterEvent("meter.pack_install", {
    pack_id: packId,
    pack_version: meta?.version ?? "0.0.0",
    nest_id: nest.id,
    price_credits_install: meta?.price_credits_install ?? 0,
    doc_count: files.length,
  });
  return c.json({ ok: true, nest: { ...nest, installed_from_pack: packId } }, 201);
});

// POST /marketplace/install-remote/:packId — install a pack FROM the
// configured central registry: pull its files over HTTP, import locally,
// stamp provenance + pricing. The meter event carries the registry origin.
marketplaceRoutes.post("/install-remote/:packId", async (c) => {
  const registryUrl = config.MARKETPLACE_REGISTRY_URL;
  if (!registryUrl) {
    throw new ValidationError(
      "No marketplace registry configured (MARKETPLACE_REGISTRY_URL).",
    );
  }
  const packId = c.req.param("packId");
  const userId = c.get("userId");

  const remote = await fetchRegistryPackFiles(registryUrl, packId);
  if (!remote) throw new NotFoundError(`Pack not found on registry: ${packId}`);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name?.trim() || remote.pack.name;

  const nest = await importNest(userId, name, remote.files);
  await registerImportedDocuments(nest.id, resolveCallerEmail(userId));
  const meta = {
    version: remote.pack.version ?? "0.0.0",
    summary: remote.pack.summary ?? "",
    price_credits_install: remote.pack.price_credits_install ?? 0,
    price_credits_per_call: remote.pack.price_credits_per_call ?? 0,
    status: "approved" as const,
  };
  getDb()
    .prepare("UPDATE nests SET installed_from_pack = ?, pack_meta = ? WHERE id = ?")
    .run(packId, JSON.stringify(meta), nest.id);

  trackMeterEvent("meter.pack_install", {
    pack_id: packId,
    pack_version: meta.version,
    nest_id: nest.id,
    price_credits_install: meta.price_credits_install,
    doc_count: remote.files.length,
    registry: registryUrl,
  });
  return c.json({ ok: true, nest: { ...nest, installed_from_pack: packId } }, 201);
});

/**
 * Artifact cards (PO-1181, agent team stream S3): the nest artifacts a message
 * points at — a `[[wikilink]]`, a document link (`…/nest/<id>?doc=<node>`), or
 * a node / hosted-artifact URL (`…/nests/<id>/nodes/<node>[/hosted]`) —
 * resolved, per viewer, to { title, type, stage, version }.
 *
 * The rule that matters (AC-ST-01): a card carries a title only for a node
 * the VIEWER can read right now. Anything else — a node they can't read, one
 * in a nest they can't open, one that doesn't exist, a link this server can't
 * place — is `{ link, resolved: false }`: the link text the viewer already
 * has, and nothing else. "Can't read" and "doesn't exist" are the same object,
 * so a card is never an existence oracle. Title-style wikilinks (`[[Secret
 * Plan]]`) are matched only among nodes the viewer can read, so even which
 * node a title would have picked never depends on what they can't see.
 *
 * Cross-nest links resolve only for a credential that isn't fenced to one
 * nest (a session, an unscoped key): a nest-scoped key gets cards for its own
 * nest and markers for the rest, the same fence /me/work applies.
 *
 * A public reader (an anonymous or non-member reader of a public nest) gets a
 * card only when the node's newest version IS its approved one — the live
 * title of an unreviewed draft is not theirs to see.
 *
 * Used by POST /nests/:id/cards (comment threads) and by the channel timeline
 * (channel-service readChannel → `cards` on every message, REST and MCP).
 */
import { getDb } from "../db/client.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { getApprovedVersion, getCurrentVersion } from "../governance/version-service.js";
import { isPublicReader } from "../shared/access.js";
import { normalizeTag } from "../governance/tag-index-service.js";

/** Most links one message contributes. */
export const MAX_LINKS_PER_TEXT = 20;
/** Most distinct links one resolve call looks up. */
export const MAX_LINKS_PER_REQUEST = 100;

export type ArtifactCard =
  | {
      link: string;
      resolved: true;
      /** "artifact" for a hosted-artifact link or an artifact node, else "node". */
      kind: "node" | "artifact";
      nest_id: string;
      node_id: string;
      title: string;
      type: string;
      /** The `#stage:` tag's value when the node has one (tasks), else null. */
      stage: string | null;
      /** draft | published | … (the node's lifecycle status). */
      status: string;
      version: number | null;
      /** In-app link to the node. */
      url: string;
    }
  | { link: string; resolved: false };

interface Ref {
  link: string;
  /** Null for a wikilink: it means the viewer's current nest. */
  nestId: string | null;
  /** An exact node id, or a wikilink target to match. */
  nodeId?: string;
  wiki?: string;
  artifact: boolean;
}

// ─── Extraction ─────────────────────────────────────────────────────────

/** Code spans and fences are source, not links (same rule as @mentions). */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

const WIKILINK = /\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;
const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;
const NEST_DOC_PATH = /^\/nest\/([^/]+)(?:\/[^/]+)?\/?$/;
const NODE_PATH = /^\/nests\/([^/]+)\/nodes\/(.+)$/;
const NODE_ID_RE = /^nodes\/[^\s]+$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function safeNodeId(raw: string): string | null {
  const id = raw.trim().replace(/\/+$/, "");
  if (!NODE_ID_RE.test(id) || id.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return id.length <= 512 ? id : null;
}

/** One link string → what it points at, or null if it isn't one we place. */
export function parseCardLink(rawLink: string): Ref | null {
  const link = String(rawLink ?? "").trim();
  if (!link || link.length > 2048) return null;
  const w = /^\[\[([^[\]\n|#]+)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]$/.exec(link);
  if (w) {
    const target = w[1].trim();
    if (!target) return null;
    if (target.includes("/")) {
      const id = safeNodeId(target.startsWith("nodes/") ? target : `nodes/${target}`);
      return id ? { link, nestId: null, nodeId: id, artifact: false } : null;
    }
    return { link, nestId: null, wiki: target, artifact: false };
  }
  if (!/^https?:\/\//i.test(link)) return null;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const doc = NEST_DOC_PATH.exec(u.pathname);
  if (doc) {
    const nodeId = safeNodeId(u.searchParams.get("doc") ?? "");
    return nodeId ? { link, nestId: decode(doc[1]), nodeId, artifact: false } : null;
  }
  const node = NODE_PATH.exec(u.pathname);
  if (node) {
    let rest = decode(node[2]);
    let artifact = false;
    const hosted = /\/(?:view\/)?hosted$/.exec(rest);
    if (hosted) {
      rest = rest.slice(0, hosted.index);
      artifact = true;
    }
    const nodeId = safeNodeId(rest.startsWith("nodes/") ? rest : `nodes/${rest}`);
    return nodeId ? { link, nestId: decode(node[1]), nodeId, artifact } : null;
  }
  return null;
}

/** The card-able links in a message, in order, deduped, capped. */
export function extractCardLinks(text: string): string[] {
  const body = stripCode(String(text ?? ""));
  const found: Array<{ at: number; link: string }> = [];
  for (const m of body.matchAll(WIKILINK)) found.push({ at: m.index ?? 0, link: m[0] });
  for (const m of body.matchAll(URL_RE)) {
    const link = m[0].replace(/[.,;:!?]+$/, "");
    if (parseCardLink(link)) found.push({ at: m.index ?? 0, link });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) {
    if (!out.includes(f.link)) out.push(f.link);
    if (out.length >= MAX_LINKS_PER_TEXT) break;
  }
  return out;
}

// ─── Resolution ─────────────────────────────────────────────────────────

export interface CardViewer {
  /** The nest the viewer is in (wikilinks resolve here). */
  nestId: string;
  userId: string;
  userEmail: string;
  /** May links into OTHER nests resolve? False for a nest-scoped key. */
  crossNest?: boolean;
}

interface IndexRow {
  node_id: string;
  title: string;
  type: string;
  status: string;
  frontmatter_json: string | null;
}

async function indexRow(nestId: string, nodeId: string): Promise<IndexRow | undefined> {
  return (await getDb().get(
    "SELECT node_id, title, type, status, frontmatter_json FROM node_index WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  )) as IndexRow | undefined;
}

function stageOf(row: IndexRow): string | null {
  try {
    const tags = JSON.parse(row.frontmatter_json ?? "{}")?.tags;
    if (!Array.isArray(tags)) return null;
    for (const t of tags) {
      if (typeof t !== "string") continue;
      const n = normalizeTag(t);
      if (n.startsWith("stage:")) return n.slice("stage:".length) || null;
    }
  } catch {
    /* no tags */
  }
  return null;
}

/**
 * Batch-resolve links for one viewer. Same order and length as `links`;
 * each entry is a card or the unresolved marker. Lookups are memoised per
 * call, so a link repeated across a timeline costs one check.
 */
export async function resolveCards(viewer: CardViewer, links: string[]): Promise<ArtifactCard[]> {
  const access = new Map<string, Promise<boolean>>();
  const publicIn = new Map<string, Promise<boolean>>();
  const canRead = (nestId: string, nodeId: string) => {
    const key = `${nestId}\u0000${nodeId}`;
    let p = access.get(key);
    if (!p) {
      // canOpenNode, not canReadNode, in this nest too: canReadNode trusts
      // the nest middleware to have admitted only members, but a doc-share
      // grantee reaches /cards with no nest permission at all, and on an
      // ungoverned nest canReadNode would answer "yes" for every node. It
      // narrows a grantee to their grants and refuses a nest they can't open.
      p = canOpenNode(nestId, nodeId, viewer.userId, viewer.userEmail).catch(() => false);
      access.set(key, p);
    }
    return p;
  };
  const isPublic = (nestId: string) => {
    let p = publicIn.get(nestId);
    if (!p) {
      p = isPublicReader(nestId, viewer.userId).catch(() => true);
      publicIn.set(nestId, p);
    }
    return p;
  };

  const resolveWiki = async (target: string): Promise<string | null> => {
    const want = target.toLowerCase();
    const slug = want
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!want) return null;
    const rows = (await getDb().all(
      `SELECT node_id, title FROM node_index
        WHERE nest_id = ? AND (LOWER(title) = ? OR node_id = ? OR node_id LIKE ?)
        LIMIT 50`,
      // An all-symbol target has no slug: match on the title alone.
      [viewer.nestId, want, slug ? `nodes/${slug}` : "", slug ? `%/${slug}` : ""],
    )) as Array<{ node_id: string; title: string }>;
    // Only among nodes the viewer can read, so the pick never depends on a
    // node they can't see.
    const readable: typeof rows = [];
    for (const r of rows) if (await canRead(viewer.nestId, r.node_id)) readable.push(r);
    const byTitle = readable.filter((r) => String(r.title ?? "").toLowerCase() === want);
    if (byTitle.length === 1) return byTitle[0].node_id;
    if (byTitle.length > 1) return null;
    if (!slug) return null;
    const bySlug = readable.filter((r) => r.node_id === `nodes/${slug}` || r.node_id.endsWith(`/${slug}`));
    return bySlug.length === 1 ? bySlug[0].node_id : null;
  };

  const one = async (link: string): Promise<ArtifactCard> => {
    const miss: ArtifactCard = { link, resolved: false };
    const ref = parseCardLink(link);
    if (!ref) return miss;
    const nestId = ref.nestId ?? viewer.nestId;
    if (nestId !== viewer.nestId && viewer.crossNest !== true) return miss;
    const nodeId = ref.nodeId ?? (ref.wiki ? await resolveWiki(ref.wiki) : null);
    if (!nodeId) return miss;
    if (!(await canRead(nestId, nodeId))) return miss;
    const row = await indexRow(nestId, nodeId);
    if (!row) return miss;
    const version = (await getCurrentVersion(nestId, nodeId)) || null;
    if (await isPublic(nestId)) {
      const approved = await getApprovedVersion(nestId, nodeId);
      if (approved === null || approved !== version) return miss;
    }
    return {
      link,
      resolved: true,
      kind: ref.artifact || row.type === "artifact" ? "artifact" : "node",
      nest_id: nestId,
      node_id: nodeId,
      title: row.title || nodeId.split("/").pop() || nodeId,
      type: row.type,
      stage: stageOf(row),
      status: row.status,
      version,
      url: `/nest/${encodeURIComponent(nestId)}?doc=${encodeURIComponent(nodeId)}`,
    };
  };

  const memo = new Map<string, Promise<ArtifactCard>>();
  return Promise.all(
    links.map((l) => {
      const link = String(l ?? "");
      let p = memo.get(link);
      if (!p) {
        p = one(link).catch(() => ({ link, resolved: false }) as ArtifactCard);
        memo.set(link, p);
      }
      return p;
    }),
  );
}

/**
 * Cards for several messages at once: links extracted per message, resolved
 * in one batch (at most MAX_LINKS_PER_REQUEST distinct), mapped back.
 */
export async function resolveMessageCards(viewer: CardViewer, bodies: string[]): Promise<ArtifactCard[][]> {
  const perMessage = bodies.map((b) => extractCardLinks(b));
  const distinct: string[] = [];
  for (const links of perMessage) {
    for (const l of links) {
      if (distinct.length >= MAX_LINKS_PER_REQUEST) break;
      if (!distinct.includes(l)) distinct.push(l);
    }
  }
  if (distinct.length === 0) return perMessage.map(() => []);
  const resolved = await resolveCards(viewer, distinct);
  const byLink = new Map(distinct.map((l, i) => [l, resolved[i]]));
  return perMessage.map((links) => links.filter((l) => byLink.has(l)).map((l) => byLink.get(l)!));
}

/** One line per card, for an agent reading over MCP. */
export function cardsText(cards: ArtifactCard[] | undefined, indent = "  "): string {
  if (!cards?.length) return "";
  return cards
    .map((c) =>
      c.resolved
        ? `\n${indent}↳ ${c.kind}: "${c.title}" (${c.type}${c.stage ? `, ${c.stage}` : ""}${c.version ? `, v${c.version}` : ""}) ${c.node_id} in nest ${c.nest_id}`
        : `\n${indent}↳ ${c.link} (unresolved)`,
    )
    .join("");
}

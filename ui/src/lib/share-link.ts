/**
 * One-click Share (PO-1365): "Share public link" in a document's menu.
 *
 *   - the document already has a working public link → copy it;
 *   - it has none → publish it with the Publish dialog's own defaults, copy the
 *     link, and say exactly what became public, with Undo and Manage.
 *
 * It is a shortcut over the same REST routes the Publish dialog calls
 * (src/nests/publish-routes.ts), so the server decides everything that
 * matters: who may publish (owner / nest admin / server admin), that only the
 * APPROVED version is ever served, and that a document with no approved version
 * gets no link. A refusal is shown in the server's own words.
 */
import { toast } from "sonner";
import * as api from "./api";
import { copyText } from "./clipboard";

/**
 * What one click publishes with: the request the Publish dialog sends when
 * nothing in it is touched. An open link ("anyone with the link"), no expiry,
 * comments off. Open rather than gated because the point of the action is a
 * link that can be pasted anywhere and simply opens; the link is unguessable,
 * serves only the approved version, and is one click to revoke. A gate is a
 * choice, and choices live in the dialog (Manage).
 */
export const ONE_CLICK_DEFAULTS = {
  access_mode: "public",
  comments_enabled: false,
  watermark: false,
  no_download: false,
  code: null,
  allowlist: [],
  expires_at: null,
} as const satisfies Omit<Parameters<typeof api.createPublication>[1], "node_id">;

/** The link Share copies when the document already has one: a working link
 *  for this document — an open one before a gated one, then the newest. */
export function liveLinkFor(
  publications: api.Publication[],
  nodeId: string,
  now: number = Date.now(),
): api.Publication | null {
  const live = publications.filter(
    (p) =>
      p.node_id === nodeId &&
      !p.revoked_at &&
      !(p.expires_at && new Date(p.expires_at).getTime() < now),
  );
  live.sort(
    (a, b) =>
      Number(b.access_mode === "public") - Number(a.access_mode === "public") ||
      b.created_at.localeCompare(a.created_at),
  );
  return live[0] ?? null;
}

/** Who can open a link, in the words the toast uses. */
export function shareLinkGate(mode: api.PublishMode): string {
  switch (mode) {
    case "public":
      return "Anyone with the link can read the approved version.";
    case "code":
      return "Readers need the passcode you set.";
    case "email":
      return "Readers confirm their email address to open it.";
    case "invite":
      return "Only the people you invited can open it.";
  }
}

export type ShareOutcome =
  | { kind: "existing"; link: string }
  | { kind: "published"; link: string }
  | { kind: "refused"; reason: string };

export interface ShareRequest {
  nestId: string;
  nodeId: string;
  title: string;
  /** Opens the Publish dialog for this document (its Links tab manages them). */
  onManage: () => void;
}

const linkOf = (p: api.Publication, link?: string) =>
  link || p.link || `${window.location.origin}/p/${p.slug}`;

// One run per document at a time: a double click must not mint two links.
const inFlight = new Map<string, Promise<ShareOutcome>>();

export function shareDocumentLink(req: ShareRequest): Promise<ShareOutcome> {
  const key = `${req.nestId}/${req.nodeId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = share(req).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function share({ nestId, nodeId, title, onManage }: ShareRequest): Promise<ShareOutcome> {
  const manage = { label: "Manage", onClick: onManage };
  try {
    const { publishes } = await api.listPublications(nestId);
    const existing = liveLinkFor(publishes, nodeId);
    if (existing) {
      const link = linkOf(existing);
      const copied = await copyText(link);
      toast.success(copied ? "Public link copied" : "This document has a public link", {
        description: copied ? shareLinkGate(existing.access_mode) : `${link} — ${shareLinkGate(existing.access_mode)}`,
        action: manage,
      });
      return { kind: "existing", link };
    }

    const created = await api.createPublication(nestId, { node_id: nodeId, ...ONE_CLICK_DEFAULTS });
    const link = linkOf(created.publish, created.link);
    const copied = await copyText(link);
    toast.success(`“${title}” is now public`, {
      description: copied
        ? "Anyone with the link can read the approved version. Link copied."
        : `Anyone with the link can read the approved version: ${link}`,
      duration: 12000,
      action: manage,
      cancel: {
        label: "Undo",
        onClick: async () => {
          try {
            await api.revokePublication(nestId, created.publish.id);
            toast.success(`“${title}” is no longer public`, { description: "The link was removed." });
          } catch (err) {
            toast.error("Couldn’t remove the link", {
              description: err instanceof Error ? err.message : undefined,
              action: manage,
            });
          }
        },
      },
    });
    return { kind: "published", link };
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : "The server refused the request.";
    toast.error("This document can’t be shared yet", { description: reason });
    return { kind: "refused", reason };
  }
}

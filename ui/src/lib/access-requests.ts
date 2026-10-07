/**
 * Access requests (CU-wdqcq041jn) — the client half.
 *
 * A write the server refuses for someone who can see the target comes back as
 * a 403 carrying `can_request_access`, the target and the level (see
 * src/governance/access-request-service.ts). `request()` in ./api turns that
 * into an `access:request-offer` window event; RequestAccessHost listens and
 * asks "Request access?" over whatever the person was doing, so an unsaved
 * edit stays exactly where it was. The editor and the nest page also open the
 * same dialog directly from a "Request edit access" button for viewers.
 */

export type AccessTargetType = "node" | "folder" | "nest";

export interface AccessTarget {
  type: AccessTargetType;
  /** A node id, a folder path ("gtm/deals"), or the nest id. */
  id: string;
}

export interface AccessRequest {
  id: string;
  nest_id: string;
  requested_by: string;
  target_type: AccessTargetType;
  target_id: string;
  level: "read" | "write";
  note: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  /** Denied recently: when asking again is allowed (ISO), else null. */
  can_ask_again_at?: string | null;
  title?: string;
}

/** What the prompt needs: where to ask, for what, and the caller's latest
 *  request for it when the refusal carried one. */
export interface AccessOffer {
  nestId: string;
  target: AccessTarget;
  level: "write";
  /** The latest pending / denied request, if the refusal carried one. */
  request?: Pick<
    AccessRequest,
    | "id"
    | "status"
    | "created_at"
    | "resolved_by"
    | "resolved_at"
    | "resolution_note"
    | "can_ask_again_at"
  > | null;
  /** Human label, when the opener knows it (the document title). */
  label?: string;
}

export const ACCESS_OFFER_EVENT = "access:request-offer";

/** The nest a /nests/<id>/… API path addresses, or null. */
export function nestIdFromApiPath(path: string): string | null {
  const m = /^\/nests\/([^/?#]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** An offer from a refused request, or null when the refusal isn't one the
 *  caller can ask about (anything but a 403 that says so). */
export function accessOfferFromError(
  path: string,
  status: number,
  body: unknown,
): AccessOffer | null {
  if (status !== 403 || !body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  if (b.can_request_access !== true) return null;
  const nestId = nestIdFromApiPath(path);
  const t = b.target;
  if (!nestId || !t || typeof t.id !== "string" || !["node", "folder", "nest"].includes(t.type)) {
    return null;
  }
  return {
    nestId,
    target: { type: t.type, id: t.id },
    level: "write",
    request:
      b.access_request && typeof b.access_request === "object" ? b.access_request : null,
  };
}

/** Plain words for a target, for the prompt. */
export function describeAccessTarget(target: AccessTarget, label?: string): string {
  if (target.type === "nest") return label ? `the nest "${label}"` : "this nest";
  if (target.type === "folder") return `the folder "${label ?? target.id}"`;
  return label ? `"${label}"` : "this document";
}

/** A denial still inside its cooldown: the time asking opens again, else null. */
export function askAgainAt(
  request: Pick<AccessRequest, "status" | "can_ask_again_at"> | null | undefined,
  now = Date.now(),
): Date | null {
  if (request?.status !== "denied" || !request.can_ask_again_at) return null;
  const at = new Date(request.can_ask_again_at);
  return Number.isFinite(at.getTime()) && at.getTime() > now ? at : null;
}

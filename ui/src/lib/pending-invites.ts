import type { WatcherNotification } from "./api";

/**
 * Nests the caller was invited to but hasn't accepted yet: an unread
 * `nest_invite` notification. They show in Pending invites, not the Nests grid.
 */
export function pendingInviteNestIds(
  notifications: Pick<WatcherNotification, "kind" | "nest_id">[] | undefined,
): Set<string> {
  return new Set(
    (notifications ?? []).filter((n) => n.kind === "nest_invite").map((n) => n.nest_id),
  );
}

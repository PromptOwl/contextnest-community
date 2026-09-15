/**
 * Notifications strip preview — pure, so the show-more/show-less rule stays
 * testable without a browser.
 *
 * The strip fetches up to 50 unread notifications in one /me/work call and
 * previously always sliced to the first 8 with no way to see the rest — a
 * report cleared from the visible 8 just pulled the 9th into its place
 * forever, so anything past #8 was unreachable. `visibleNotifications` is the
 * single place that decides how many of the fetched list to render, so the
 * "Show all" toggle can flip it without duplicating the slicing rule.
 */
export const NOTIFICATIONS_PREVIEW_COUNT = 8;

export function visibleNotifications<T>(
  notifications: T[],
  expanded: boolean,
  previewCount: number = NOTIFICATIONS_PREVIEW_COUNT,
): T[] {
  return expanded ? notifications : notifications.slice(0, previewCount);
}

/**
 * Drop a notification from the (unread-only) local list once it's been read —
 * shared by the per-row dismiss button and opening a notification, so both
 * paths agree on what "read" removes.
 */
export function dismissNotification<T extends { id: string }>(
  notifications: T[],
  id: string,
): T[] {
  return notifications.filter((x) => x.id !== id);
}

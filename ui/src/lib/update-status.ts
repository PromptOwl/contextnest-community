import type { UpdateStatus } from "./api";

/** localStorage key holding the version the admin dismissed. */
export const DISMISSED_KEY = "update:dismissed";

/** The version to announce, or null: nothing newer, or this one was dismissed
 *  (a later release shows again). */
export function updateToAnnounce(status: UpdateStatus | undefined, dismissed: string | null): string | null {
  if (!status?.update_available || !status.latest) return null;
  return status.latest === dismissed ? null : status.latest;
}

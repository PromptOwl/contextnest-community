/**
 * Where the harness's panes go at a given width (PO-1200, AC-C3-05,
 * AC-C3-07, AC-C3-10), and where its launcher sits beside Hootie's. Pure, so
 * the page reads one answer and the rules are tested on numbers.
 */

/** At or above this the thread opens beside the conversation; below, a sheet. */
export const THREAD_BESIDE_MIN = 1100;
/** At or above this the context rail is its own column; below, it folds into
 *  the top of the thread pane. */
export const RAIL_COLUMN_MIN = 1600;
/** At or above this the channel list is a column; below, a sheet. */
export const SIDEBAR_INLINE_MIN = 768;

export interface PaneLayout {
  sidebar: "inline" | "sheet";
  thread: "beside" | "sheet";
  rail: "column" | "folded";
}

export function paneLayout(width: number): PaneLayout {
  return {
    sidebar: width >= SIDEBAR_INLINE_MIN ? "inline" : "sheet",
    thread: width >= THREAD_BESIDE_MIN ? "beside" : "sheet",
    rail: width >= RAIL_COLUMN_MIN ? "column" : "folded",
  };
}

/** The chat launcher stacks under Hootie's tab when that one is on screen,
 *  and takes its place (mid-height) when it is not; on a phone it is a
 *  button in the bottom corner. */
export function launcherPlacement(hootieShown: boolean, width = 1440): "below-hootie" | "centre" | "corner" {
  // A phone: a round button in the bottom corner, where a chat button is
  // looked for, instead of a tab over the page's middle (PO-1200).
  if (width < LAUNCHER_CORNER_MAX) return "corner";
  return hootieShown ? "below-hootie" : "centre";
}

/** Below this width the launcher is a corner button. */
export const LAUNCHER_CORNER_MAX = 640;

/** The launcher shows on a nest page when the switch is on, the caller is a
 *  person added to the nest, and the page is not the chat itself. */
export function launcherShown(input: { streamOn: boolean; member: boolean | null | undefined; onChatPage: boolean }): boolean {
  return input.streamOn && input.member === true && !input.onChatPage;
}

/**
 * The "jump to latest" pill: shown while the list is scrolled away from its
 * end, with a count when messages arrived meanwhile. `distance` is how far
 * the bottom edge of the viewport is from the end of the list.
 */
export function jumpPill(distance: number, arrived: number): { shown: boolean; label: string } {
  const shown = distance > 80;
  if (!shown) return { shown: false, label: "" };
  if (arrived <= 0) return { shown: true, label: "Jump to latest" };
  return { shown: true, label: arrived === 1 ? "1 new message" : `${arrived} new messages` };
}

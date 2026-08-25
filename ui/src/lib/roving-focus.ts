/**
 * Roving tabindex — the pattern that makes a row of controls ONE tab stop.
 *
 * A toolbar of 16 buttons is 16 tab stops by default, so a keyboard user
 * leaving the Title field has to press Tab twenty-odd times to reach the
 * writing area. ARIA's answer (and what every native toolbar does) is to keep
 * exactly one item tabbable and move between the rest with the arrow keys.
 *
 * The index maths lives here, apart from the DOM, so it can be tested.
 */

const HORIZONTAL = ["ArrowRight", "ArrowLeft"];
const VERTICAL = ["ArrowDown", "ArrowUp"];
export const ROVING_KEYS = [...HORIZONTAL, ...VERTICAL, "Home", "End"];

/**
 * Where focus goes for `key`, or null if the key isn't ours. Wraps at both
 * ends: a toolbar is a loop, not a list with edges to get stuck against.
 */
export function nextFocusIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count < 1 || current < 0 || current >= count) return null;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    default:
      return null;
  }
}

/**
 * Which item holds the group's single tab stop.
 *
 * Focus wins when it is already inside the group, so tabbing away and back
 * returns to where the user was. Otherwise the selected item (a checked radio
 * in a segmented control) — entering a group should land on its current value,
 * not always on its first button. Falling back to 0 keeps the group reachable
 * when nothing is selected.
 */
export function tabStopIndex(focused: number, selected: number): number {
  if (focused >= 0) return focused;
  if (selected >= 0) return selected;
  return 0;
}

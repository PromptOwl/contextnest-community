/**
 * Enter in a chat box (PO-1189): the channel composer and the thread reply
 * box send on Enter and add a line on Shift+Enter. Document comments keep
 * their own behaviour (Enter adds a line); this is opt-in on MentionTextarea.
 */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** An input method is mid-composition (CJK and others): Enter belongs to it. */
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Does this key press send the message? A plain Enter, with no modifier, not
 * while composing, and not on a touch device: an on-screen keyboard has no
 * Shift+Enter, so there Enter adds a line and the button sends.
 */
export function enterSends(e: KeyLike, opts: { coarsePointer: boolean }): boolean {
  if (e.key !== "Enter") return false;
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return !opts.coarsePointer;
}

/** The media query for "the main pointer is a finger". */
export const COARSE_POINTER = "(pointer: coarse)";

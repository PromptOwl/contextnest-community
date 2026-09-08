/**
 * What a workflow wire says about itself on the canvas.
 *
 * Pure and framework-free so it is unit-testable in the node test env, like
 * the other list/filter helpers here. The label is drawn in a fixed 10px
 * monospace face, so its width follows from its length.
 */

/** One character of the label's 10px monospace face. */
export const WIRE_CHAR_W = 6;

/** About a column pitch of text — beyond that a label starts crowding the
 *  next wire, and the full rule is on hover anyway. */
export const WIRE_LABEL_MAX = 46;

/** The wire's label: what is drawn, the whole rule for the hover title, and
 *  the width of the plate that keeps the wire from striking through it. */
export function wireLabel(typeName: string, condition: string) {
  const full = condition ? `${typeName} · ${condition}` : typeName;
  const short =
    full.length > WIRE_LABEL_MAX
      ? `${full.slice(0, WIRE_LABEL_MAX - 1).trimEnd()}…`
      : full;
  return { full, short, width: short.length * WIRE_CHAR_W + 8 };
}

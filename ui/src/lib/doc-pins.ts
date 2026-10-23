/**
 * Document pins (CU-wdqcq02crw) — pure helpers for the pinned strip and the
 * document header's pin control. Kept out of the components so the ordering
 * rule is tested without mounting React.
 */
import type { DocPins } from "./api";

/**
 * The editorial order after dragging `dragged` onto `target` (it lands just
 * before the target; `null` = dropped past the last pin, so it goes last).
 * Returns the input unchanged when the move means nothing.
 */
export function movePin(ids: string[], dragged: string, target: string | null): string[] {
  if (!ids.includes(dragged) || dragged === target) return ids;
  const rest = ids.filter((id) => id !== dragged);
  if (target === null) return [...rest, dragged];
  const at = rest.indexOf(target);
  if (at < 0) return ids;
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

/** Whether one document is pinned for everyone, for me, or either. */
export function pinStateFor(
  pins: DocPins | undefined,
  nodeId: string,
): { editorial: boolean; personal: boolean; any: boolean } {
  const editorial = !!pins?.editorial.some((p) => p.node_id === nodeId);
  const personal = !!pins?.personal.some((p) => p.node_id === nodeId);
  return { editorial, personal, any: editorial || personal };
}

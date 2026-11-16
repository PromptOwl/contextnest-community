/** The View `view:` block as the editor sees it. Other kinds ride along untouched. */
export type ViewBlock = Record<string, unknown>;
export interface ViewMeta {
  blocks: ViewBlock[];
  [key: string]: unknown;
}

/** Engine rule 32 refuses an empty `blocks`, so every create/convert sends one. */
export const VIEW_SEED_BLOCK: ViewBlock = { callout: { text: "Add blocks to this view." } };

/** Stable text form of a view, for dirty checks. */
export function viewJson(view: ViewMeta): string {
  return JSON.stringify(view);
}

export const EDITABLE_BLOCK_KINDS = ["md", "list", "callout"] as const;
export type EditableBlockKind = (typeof EDITABLE_BLOCK_KINDS)[number];

/** The block's kind key (`md`, `list`, …), ignoring `id` and other siblings. */
export function blockKind(block: ViewBlock): string {
  return Object.keys(block).find((k) => k !== "id" && k !== "render" && k !== "audience") ?? "";
}

export function isEditableBlock(block: ViewBlock): boolean {
  return (EDITABLE_BLOCK_KINDS as readonly string[]).includes(blockKind(block));
}

export function newBlock(kind: EditableBlockKind): ViewBlock {
  if (kind === "md") return { md: { ref: "" } };
  if (kind === "list") return { list: { select: "" } };
  return { callout: { text: "" } };
}

/** Move the block at `index` by `delta`; the array is returned as-is at the edges. */
export function moveBlock(blocks: ViewBlock[], index: number, delta: -1 | 1): ViewBlock[] {
  const to = index + delta;
  if (to < 0 || to >= blocks.length) return blocks;
  const next = blocks.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

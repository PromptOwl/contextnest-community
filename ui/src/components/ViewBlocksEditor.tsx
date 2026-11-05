/** Controlled block list for a View: add, remove, reorder md / list / callout blocks. */
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  blockKind,
  isEditableBlock,
  moveBlock,
  newBlock,
  type EditableBlockKind,
  type ViewBlock,
} from "../lib/view-blocks";

export interface ViewBlocksEditorProps {
  blocks: ViewBlock[];
  onChange: (blocks: ViewBlock[]) => void;
  disabled?: boolean;
}

const FIELD: Record<EditableBlockKind, { key: string; label: string; placeholder: string }> = {
  md: { key: "ref", label: "Show a node", placeholder: "nodes/overview" },
  list: { key: "select", label: "List nodes matching", placeholder: "#board-metric" },
  callout: { key: "text", label: "Callout text", placeholder: "Say something to the reader" },
};

const ADD_LABEL: Record<EditableBlockKind, string> = { md: "Node", list: "List", callout: "Callout" };

export function ViewBlocksEditor({ blocks, onChange, disabled = false }: ViewBlocksEditorProps) {
  // Only the typed value changes; id and any other keys on the block are kept.
  const setField = (index: number, kind: EditableBlockKind, value: string) => {
    const block = blocks[index];
    const inner = (block[kind] ?? {}) as Record<string, unknown>;
    const next = blocks.slice();
    next[index] = { ...block, [kind]: { ...inner, [FIELD[kind].key]: value } };
    onChange(next);
  };

  return (
    <div className="space-y-2" data-testid="view-blocks-editor">
      <div className="text-xs font-medium text-muted-foreground">Blocks</div>
      <ul className="space-y-2">
        {blocks.map((block, i) => {
          const kind = blockKind(block);
          if (!isEditableBlock(block)) {
            // Kept in place and sent back unchanged: a save replaces the whole list.
            return (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
                data-testid="view-block-locked"
              >
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>
                  <span className="font-medium">{kind || "unknown"}</span> block — edited outside the app, kept as is.
                </span>
              </li>
            );
          }
          const k = kind as EditableBlockKind;
          const field = FIELD[k];
          const value = String(((block[k] ?? {}) as Record<string, unknown>)[field.key] ?? "");
          return (
            <li key={i} className="flex items-center gap-2 rounded-md border px-3 py-2" data-testid={`view-block-${k}`}>
              <span className="w-16 shrink-0 text-xs font-medium uppercase text-muted-foreground">{k}</span>
              <Input
                value={value}
                disabled={disabled}
                aria-label={field.label}
                placeholder={field.placeholder}
                onChange={(e) => setField(i, k, e.target.value)}
                className="h-8"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || i === 0}
                aria-label="Move up"
                onClick={() => onChange(moveBlock(blocks, i, -1))}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled || i === blocks.length - 1}
                aria-label="Move down"
                onClick={() => onChange(moveBlock(blocks, i, 1))}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled}
                aria-label="Remove block"
                onClick={() => onChange(blocks.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ul>
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(FIELD) as EditableBlockKind[]).map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange([...blocks, newBlock(kind)])}
              data-testid={`view-add-${kind}`}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {ADD_LABEL[kind]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Keyboard shortcuts cheatsheet — opened with `?` or from the account menu.
 *
 * A static list on purpose: the bindings live where they are handled (the
 * Cmd/Ctrl+K listener in App, TipTap's own editor keymap), and a registry that
 * every call site had to remember to write into would drift from them just as
 * easily as this table does — with more code in between.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Ctrl on Windows/Linux, ⌘ on a Mac — the label follows the platform. */
const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl";

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Anywhere",
    items: [
      [`${MOD} K`, "Search nests and documents"],
      ["/", "Search nests and documents"],
      ["?", "Show this cheatsheet"],
      ["Esc", "Close a dialog or the search palette"],
    ],
  },
  {
    title: "Search palette",
    items: [
      ["↑ ↓", "Move between results"],
      ["Enter", "Open the selected result"],
    ],
  },
  {
    title: "Editing a document",
    items: [
      [`${MOD} B`, "Bold"],
      [`${MOD} I`, "Italic"],
      [`${MOD} Z`, "Undo"],
      [`${MOD} ⇧ Z`, "Redo"],
      ["# / ## / ###", "Heading, typed at the start of a line"],
      ["[[", "Link to another document"],
      ["@", "Mention a person"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="rounded border px-1">?</kbd> anywhere to bring
            this back.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </div>
              <dl className="space-y-1">
                {group.items.map(([keys, what]) => (
                  <div key={keys} className="flex items-baseline gap-3 text-sm">
                    <dt className="w-32 shrink-0">
                      <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="text-muted-foreground">{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

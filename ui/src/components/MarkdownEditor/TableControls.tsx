import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Plus, Trash2, ArrowLeft, ArrowRight, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface Edge {
  start: number; // left (cols) or top (rows), viewport px
  size: number; // width (cols) or height (rows)
  center: number;
}
interface Geo {
  table: DOMRect;
  clip: DOMRect; // visible region of the scroll container
  cols: Edge[];
  rows: Edge[];
}
type Menu =
  | { kind: "col"; index: number; x: number; y: number }
  | { kind: "row"; index: number; x: number; y: number }
  | null;

/**
 * Notion-style inline table controls. On hover over a table, grips appear
 * above each column and left of each row; clicking a grip opens a small menu
 * (insert before/after · delete). A `+` bar on the right adds a column, one
 * on the bottom adds a row. Rendered as fixed-position overlays measured from
 * live DOM rects, so they track scroll/resize without offsetParent math.
 */
export function TableControls({ editor }: { editor: Editor }) {
  const [tableEl, setTableEl] = useState<HTMLTableElement | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  // Track which table the pointer is over (delegated on the editor DOM).
  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    const onMove = (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest(
        "table",
      ) as HTMLTableElement | null;
      if (t) setTableEl(t);
    };
    dom.addEventListener("mousemove", onMove);
    return () => dom.removeEventListener("mousemove", onMove);
  }, [editor]);

  // Hide controls only after the pointer truly leaves the table AND its
  // surrounding control band. The grips sit just outside the table edge, so a
  // small keep-alive margin bridges the gap; a short delay lets the pointer
  // cross it without the grips unmounting mid-move.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (menu) return;
      const el = e.target as HTMLElement;
      const keep =
        !!el.closest("table") || !!el.closest("[data-table-control]");
      let near = keep;
      if (!near && tableEl) {
        const r = tableEl.getBoundingClientRect();
        const m = 32; // covers grips (≤12px) + add bars (≤17px) + gap
        near =
          e.clientX >= r.left - m &&
          e.clientX <= r.right + m &&
          e.clientY >= r.top - m &&
          e.clientY <= r.bottom + m;
      }
      window.clearTimeout(hideTimer.current);
      if (!near) hideTimer.current = window.setTimeout(() => setTableEl(null), 120);
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      window.clearTimeout(hideTimer.current);
    };
  }, [menu, tableEl]);

  const measure = useCallback(() => {
    if (!tableEl || !tableEl.isConnected) {
      setGeo(null);
      return;
    }
    const scroller = (editor.view.dom as HTMLElement).parentElement;
    const clip = scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, 9999, 9999);
    const table = tableEl.getBoundingClientRect();
    const firstRow = tableEl.querySelector("tr");
    const rowEls = Array.from(tableEl.querySelectorAll("tr"));
    if (!firstRow) {
      setGeo(null);
      return;
    }
    const cols: Edge[] = Array.from(firstRow.children).map((c) => {
      const r = (c as HTMLElement).getBoundingClientRect();
      return { start: r.left, size: r.width, center: r.left + r.width / 2 };
    });
    const rows: Edge[] = rowEls.map((rw) => {
      const r = rw.getBoundingClientRect();
      return { start: r.top, size: r.height, center: r.top + r.height / 2 };
    });
    setGeo({ table, clip, cols, rows });
  }, [tableEl, editor]);

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    if (!tableEl) return;
    const fn = () => measure();
    window.addEventListener("scroll", fn, true);
    window.addEventListener("resize", fn);
    editor.on("update", fn);
    return () => {
      window.removeEventListener("scroll", fn, true);
      window.removeEventListener("resize", fn);
      editor.off("update", fn);
    };
  }, [tableEl, measure, editor]);

  // Put the caret into the cell at [rowIndex, colIndex] so the table command
  // acts on that row/column, then run it.
  const runAtCell = (
    rowIndex: number,
    colIndex: number,
    cmd: (e: Editor) => void,
  ) => {
    if (!tableEl) return;
    const rowEls = tableEl.querySelectorAll("tr");
    const rowEl = rowEls[rowIndex] as HTMLElement | undefined;
    const cell = rowEl?.children[colIndex] as HTMLElement | undefined;
    if (!cell) return;
    const pos = editor.view.posAtDOM(cell, 0);
    editor.chain().focus().setTextSelection(pos).run();
    cmd(editor);
    setMenu(null);
    window.requestAnimationFrame(measure);
  };

  if (!geo) return null;

  // Off-screen (scrolled out of the editor viewport) → don't render.
  const visible =
    geo.table.bottom > geo.clip.top && geo.table.top < geo.clip.bottom;
  if (!visible) return null;

  const clampY = (y: number) => Math.max(geo.clip.top, Math.min(geo.clip.bottom, y));

  return (
    <>
      {/* Column grips (above each column). */}
      {geo.cols.map((c, i) => (
        <button
          key={`col-${i}`}
          data-table-control
          type="button"
          title="Column actions"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setMenu({ kind: "col", index: i, x: c.center, y: geo.table.top })
          }
          className="fixed z-40 flex items-center justify-center rounded-sm bg-border/70 text-muted-foreground hover:bg-primary hover:text-primary-foreground"
          style={{
            left: c.start + 1,
            top: clampY(geo.table.top - 12),
            width: c.size - 2,
            height: 9,
          }}
        >
          <span className="text-[8px] leading-none">⋯</span>
        </button>
      ))}

      {/* Row grips (left of each row). */}
      {geo.rows.map((r, i) => (
        <button
          key={`row-${i}`}
          data-table-control
          type="button"
          title="Row actions"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setMenu({ kind: "row", index: i, x: geo.table.left, y: r.center })
          }
          className="fixed z-40 flex items-center justify-center rounded-sm bg-border/70 text-muted-foreground hover:bg-primary hover:text-primary-foreground"
          style={{
            left: geo.table.left - 12,
            top: clampY(r.start + 1),
            width: 9,
            height: r.size - 2,
          }}
        >
          <span className="rotate-90 text-[8px] leading-none">⋯</span>
        </button>
      ))}

      {/* Add-column bar (right edge). */}
      <button
        data-table-control
        type="button"
        title="Add column"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runAtCell(0, geo.cols.length - 1, (e) =>
          e.chain().focus().addColumnAfter().run(),
        )}
        className="fixed z-40 flex items-center justify-center rounded-sm bg-border/50 text-muted-foreground hover:bg-primary hover:text-primary-foreground"
        style={{
          left: geo.table.right + 3,
          top: clampY(geo.table.top),
          width: 14,
          height: Math.min(geo.table.height, geo.clip.bottom - geo.table.top),
        }}
      >
        <Plus className="h-3 w-3" />
      </button>

      {/* Add-row bar (bottom edge). */}
      <button
        data-table-control
        type="button"
        title="Add row"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => runAtCell(geo.rows.length - 1, 0, (e) =>
          e.chain().focus().addRowAfter().run(),
        )}
        className="fixed z-40 flex items-center justify-center rounded-sm bg-border/50 text-muted-foreground hover:bg-primary hover:text-primary-foreground"
        style={{
          left: geo.table.left,
          top: clampY(geo.table.bottom + 3),
          width: geo.table.width,
          height: 14,
        }}
      >
        <Plus className="h-3 w-3" />
      </button>

      {/* Grip menu. */}
      {menu && (
        <div
          data-table-control
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          style={{ left: menu.x, top: clampY(menu.y) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {menu.kind === "col" ? (
            <>
              <MenuRow
                onClick={() =>
                  runAtCell(0, menu.index, (e) =>
                    e.chain().focus().addColumnBefore().run(),
                  )
                }
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Insert left
              </MenuRow>
              <MenuRow
                onClick={() =>
                  runAtCell(0, menu.index, (e) =>
                    e.chain().focus().addColumnAfter().run(),
                  )
                }
              >
                <ArrowRight className="h-3.5 w-3.5" /> Insert right
              </MenuRow>
              <MenuRow
                destructive
                onClick={() =>
                  runAtCell(0, menu.index, (e) =>
                    e.chain().focus().deleteColumn().run(),
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete column
              </MenuRow>
            </>
          ) : (
            <>
              <MenuRow
                onClick={() =>
                  runAtCell(menu.index, 0, (e) =>
                    e.chain().focus().addRowBefore().run(),
                  )
                }
              >
                <ArrowUp className="h-3.5 w-3.5" /> Insert above
              </MenuRow>
              <MenuRow
                onClick={() =>
                  runAtCell(menu.index, 0, (e) =>
                    e.chain().focus().addRowAfter().run(),
                  )
                }
              >
                <ArrowDown className="h-3.5 w-3.5" /> Insert below
              </MenuRow>
              <MenuRow
                destructive
                onClick={() =>
                  runAtCell(menu.index, 0, (e) =>
                    e.chain().focus().deleteRow().run(),
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete row
              </MenuRow>
            </>
          )}
        </div>
      )}

      {/* Backdrop to close the menu on outside click. */}
      {menu && (
        <div
          className="fixed inset-0 z-30"
          onMouseDown={() => setMenu(null)}
        />
      )}
    </>
  );
}

function MenuRow({
  onClick,
  destructive,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted",
        destructive && "text-destructive",
      )}
    >
      {children}
    </button>
  );
}

export default TableControls;

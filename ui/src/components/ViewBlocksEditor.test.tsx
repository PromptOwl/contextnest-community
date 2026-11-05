/** CU-wdqcq041ku: the View block list keeps blocks it cannot edit, in place. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewBlocksEditor } from "./ViewBlocksEditor";
import { VIEW_SEED_BLOCK, blockKind, isEditableBlock, moveBlock, newBlock } from "../lib/view-blocks";

const html = { id: "h", html: { ref: "nodes/dash", data_from: ["m"] } };
const summary = { summary: { ref: "nodes/x" } };
const md = { md: { ref: "nodes/overview" } };

describe("view-blocks helpers", () => {
  it("reads the kind past id", () => {
    expect(blockKind({ id: "m", list: { select: "#a" } })).toBe("list");
  });

  it("treats only md, list and callout as editable", () => {
    expect([md, newBlock("list"), newBlock("callout")].every(isEditableBlock)).toBe(true);
    expect(isEditableBlock(html)).toBe(false);
    expect(isEditableBlock(summary)).toBe(false);
  });

  it("moving a block never drops or alters the others, locked ones included", () => {
    const blocks = [md, html, newBlock("callout"), summary];
    const moved = moveBlock(blocks, 2, -1);
    expect(moved).toHaveLength(4);
    expect(moved).toContain(html);
    expect(moved).toContain(summary);
    expect(moved.indexOf(summary)).toBe(3);
    expect(moveBlock(blocks, 0, -1)).toBe(blocks);
  });

  it("the seed block is a callout, so a new View is never empty", () => {
    expect(blockKind(VIEW_SEED_BLOCK)).toBe("callout");
  });
});

describe("ViewBlocksEditor", () => {
  const out = renderToStaticMarkup(
    <ViewBlocksEditor blocks={[md, html, summary, newBlock("callout")]} onChange={() => {}} />,
  );

  it("renders a locked row for each block kind it cannot edit", () => {
    expect(out.match(/data-testid="view-block-locked"/g)).toHaveLength(2);
    expect(out).toContain("kept as is");
  });

  it("gives locked rows no inputs or controls", () => {
    expect(out.match(/aria-label="Remove block"/g)).toHaveLength(2);
  });

  it("offers no add buttons when disabled", () => {
    const ro = renderToStaticMarkup(<ViewBlocksEditor blocks={[md]} onChange={() => {}} disabled />);
    expect(ro).not.toContain("view-add-md");
  });
});

describe("DocumentEditor wiring", () => {
  const src = readFileSync(new URL("./DocumentEditor.tsx", import.meta.url), "utf8");

  it("offers View only when the server accepts the type", () => {
    expect(src).toMatch(/typeViewEnabled\s*\?\s*\[\s*\{\s*value: "view"/);
  });

  it("sends the seed block when turning a node into a View", () => {
    expect(src).toMatch(/turnInto === "view"[\s\S]{0,80}VIEW_SEED_BLOCK/);
  });

  it("sends the whole block list back on save, only when it changed", () => {
    expect(src).toMatch(/viewJson\(viewMeta\) !== loadedViewRef\.current/);
  });

  it("puts the saved blocks back on discard and parks unsaved ones", () => {
    expect(src).toMatch(/revertToSaved = \(\) => \{[\s\S]{0,300}setViewMeta\(loadedViewRef\.current/);
    expect(src).toMatch(/writeDraft\(nestId, nodeId, \{[\s\S]{0,200}view: viewMeta/);
    expect(src).toMatch(/draft\.view\) setViewMeta/);
  });
});

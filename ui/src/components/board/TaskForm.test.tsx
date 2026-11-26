import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RESIZABLE_DIALOG, TaskForm } from "./CreateTaskDialog";

vi.mock("../MarkdownEditor", () => ({
  MarkdownEditor: (p: { editable?: boolean; nestId?: string }) => <div data-testid="rich-editor" data-editable={String(p.editable)} data-nest={p.nestId} />,
}));

const noop = () => {};
const html = (over: Partial<Parameters<typeof TaskForm>[0]> = {}) =>
  renderToStaticMarkup(
    <TaskForm nestId="n1" people={[]} folder="" onFolder={noop} saving={false} onSubmit={noop} onClose={noop} {...over} />,
  );

describe("TaskForm", () => {
  it("po-1245: offers Create and add another beside Create task, and focuses the title", () => {
    const out = html();
    expect(out).toContain("Create and add another");
    expect(out).toContain("Create task");
    expect(out).toMatch(/<input[^>]*aria-label="Title"/);
    expect(out).toMatch(/autofocus=""/i);
  });
  it("po-1205: the description resizes both ways and the dialog follows its width", () => {
    const classes = html().match(/aria-label="Description" class="([^"]*)"/)?.[1].split(" ") ?? [];
    expect(classes).toContain("resize");
    expect(classes).toContain("min-w-full");
    expect(RESIZABLE_DIALOG).toContain("w-fit");
    expect(RESIZABLE_DIALOG).not.toContain("overflow");
  });
  it("po-1204: the description is the rich editor of this nest, locked while saving", () => {
    expect(html()).toContain('data-testid="rich-editor" data-editable="true" data-nest="n1"');
    expect(html({ saving: true })).toContain('data-editable="false"');
    expect(html()).not.toContain("<textarea");
  });
  it("po-1207: shows the folder picker when the folders are known, kept on the folder in hand", () => {
    expect(html({ folders: ["gtm"], folder: "gtm" })).toContain("Gtm");
    expect(html()).not.toContain("create-task-folder");
  });
});

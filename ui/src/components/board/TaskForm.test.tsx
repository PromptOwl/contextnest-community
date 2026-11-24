import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskForm } from "./CreateTaskDialog";

const noop = () => {};
const html = (over: Partial<Parameters<typeof TaskForm>[0]> = {}) =>
  renderToStaticMarkup(
    <TaskForm people={[]} folder="" onFolder={noop} saving={false} onSubmit={noop} onClose={noop} {...over} />,
  );

describe("TaskForm", () => {
  it("po-1245: offers Create and add another beside Create task, and focuses the title", () => {
    const out = html();
    expect(out).toContain("Create and add another");
    expect(out).toContain("Create task");
    expect(out).toMatch(/<input[^>]*aria-label="Title"/);
    expect(out).toMatch(/autofocus=""/i);
  });
  it("po-1207: shows the folder picker when the folders are known, kept on the folder in hand", () => {
    expect(html({ folders: ["gtm"], folder: "gtm" })).toContain("Gtm");
    expect(html()).not.toContain("create-task-folder");
  });
});

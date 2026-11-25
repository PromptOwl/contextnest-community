import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardListView } from "./BoardListView";

const noop = () => {};
const list = (canAddTo: (key: string) => boolean) =>
  renderToStaticMarkup(
    <BoardListView
      nestId="n1"
      dimension="folder"
      sections={[
        { key: "gtm", label: "Gtm", nodes: [] },
        { key: "second", label: "Second", nodes: [] },
      ]}
      boardColumns={[]}
      allNodes={[]}
      columnsOf={() => []}
      columnLabel={(k) => k}
      people={[]}
      personLabel={(e) => e}
      canEdit
      canAddTo={canAddTo}
      onAddTask={noop}
      governance={{} as never}
      doneTags={[]}
      tagSuggestions={[]}
      onOpen={noop}
      onChanged={async () => {}}
    />,
  );

describe("po-1264: Add task in the List layout", () => {
  it("every section offers it, an empty one included", () => {
    const html = list(() => true);
    expect(html).toContain('data-testid="list-add-task-gtm"');
    expect(html).toContain('aria-label="Add task to Second"');
  });
  it("is left out where a task can't be created", () => {
    const html = list((k) => k === "gtm");
    expect(html).toContain("list-add-task-gtm");
    expect(html).not.toContain("list-add-task-second");
  });
});

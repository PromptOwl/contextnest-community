/** Assign users directly from the task view. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskAssignee } from "./TaskAssignee";

const people = [
  { email: "ada@acme.dev", name: "Ada Lovelace", member: true },
  { email: "bob@acme.dev", name: null, member: true },
];
const html = (p: { assignee?: string; canEdit: boolean }) =>
  renderToStaticMarkup(
    <TaskAssignee nestId="n1" nodeId="nodes/t1" people={people} onSaved={() => {}} {...p} />,
  );

describe("TaskAssignee", () => {
  it("shows the assignee's name, as a menu trigger when editable", () => {
    const h = html({ assignee: "ada@acme.dev", canEdit: true });
    expect(h).toContain("Assignee");
    expect(h).toContain("Ada Lovelace");
    expect(h).toContain('aria-haspopup="menu"');
  });

  it("an unassigned task reads Unassigned and the picker stays visible", () => {
    const h = html({ canEdit: true });
    expect(h).toContain("Unassigned");
    expect(h).not.toContain("opacity-0");
  });

  it("read-only viewers see the assignee without a picker", () => {
    const h = html({ assignee: "bob@acme.dev", canEdit: false });
    expect(h).toContain("bob@acme.dev");
    expect(h).not.toContain('aria-haspopup="menu"');
  });
});

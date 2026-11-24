/** Open a dedicated dialog when creating a task via Board. */
import { describe, it, expect } from "vitest";
import { newTaskPayload } from "./CreateTaskDialog";

describe("newTaskPayload", () => {
  it("sends every field the dialog set, with the title trimmed", () => {
    expect(
      newTaskPayload({
        title: "  Fix login  ",
        content: "Steps…",
        assignee: "ada@acme.dev",
        priority: "high",
        due: "2026-11-01",
      }),
    ).toEqual({ title: "Fix login", content: "Steps…", assignee: "ada@acme.dev", priority: "high", due: "2026-11-01" });
  });

  it("leaves blank fields out, so the column and filter values still apply", () => {
    expect(newTaskPayload({ title: "Fix login", content: "", assignee: undefined, priority: "", due: "" })).toEqual({
      title: "Fix login",
      content: "",
    });
  });

  it("carries the surface picked, and leaves it out when none was", () => {
    expect(newTaskPayload({ title: "A", content: "", surfaceTag: "community" })).toEqual({
      title: "A",
      content: "",
      surfaceTag: "community",
    });
    expect(newTaskPayload({ title: "A", content: "", surfaceTag: "" })).toEqual({ title: "A", content: "" });
  });

  it("po-1207: carries the folder picked, the nest root included; left out it stays the column's", () => {
    expect(newTaskPayload({ title: "A", content: "", folder: "gtm/deals" })).toMatchObject({ folder: "gtm/deals" });
    expect(newTaskPayload({ title: "A", content: "", folder: "" })).toMatchObject({ folder: "" });
    expect(newTaskPayload({ title: "A", content: "" })).not.toHaveProperty("folder");
  });

  it("refuses a blank title", () => {
    expect(newTaskPayload({ title: "   ", content: "notes" })).toBeNull();
  });
});

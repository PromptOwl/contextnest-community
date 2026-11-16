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

  it("refuses a blank title", () => {
    expect(newTaskPayload({ title: "   ", content: "notes" })).toBeNull();
  });
});

/**
 * The tag board's group picker lists the tag groups in use (stage:, surface:)
 * with how many values and cards each has. Ticket numbers are one tag per card,
 * so they are never offered as a group.
 */
import { describe, it, expect } from "vitest";
import { tagNamespaces, type BoardNode } from "../ui/src/lib/board-dimensions";

const node = (id: string, tags: string[]): BoardNode => ({
  id,
  title: id,
  type: "task",
  tags,
  status: "published",
});

describe("tagNamespaces", () => {
  it("counts the values and the cards of each group", () => {
    const groups = tagNamespaces([
      node("a", ["stage:backlog", "surface:community"]),
      node("b", ["stage:backlog"]),
      node("c", ["stage:in-review", "surface:marketing"]),
    ]);
    expect(groups).toEqual([
      { namespace: "stage", values: 2, cards: 3 },
      { namespace: "surface", values: 2, cards: 2 },
    ]);
  });

  it("reads tags with or without the leading #, case-insensitively", () => {
    const groups = tagNamespaces([node("a", ["#Stage:Backlog"]), node("b", ["stage:backlog"])]);
    expect(groups).toEqual([{ namespace: "stage", values: 1, cards: 2 }]);
  });

  it("ignores flat tags and never offers the ticket group", () => {
    const groups = tagNamespaces([
      node("a", ["projects", "ticket:po-1"]),
      node("b", ["ticket:po-2", "stage:done"]),
    ]);
    expect(groups.map((g) => g.namespace)).toEqual(["stage"]);
  });

  it("is empty when no tag has a group", () => {
    expect(tagNamespaces([node("a", ["projects", "engineering"])])).toEqual([]);
  });
});

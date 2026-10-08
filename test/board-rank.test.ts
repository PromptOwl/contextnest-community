import { describe, it, expect } from "vitest";
import { orderByRank, placeCard, rankKey } from "../ui/src/lib/board-rank";

const c = (...ids: string[]) => ids.map((id) => ({ id }));

describe("board rank", () => {
  it("orders ranked cards first, unranked after in their given order", () => {
    expect(orderByRank(c("a", "b", "c", "d"), ["c", "a"]).map((x) => x.id)).toEqual(["c", "a", "b", "d"]);
    expect(orderByRank(c("a", "b"), undefined).map((x) => x.id)).toEqual(["a", "b"]);
    // Stale ids in the rank (card left the column) are ignored.
    expect(orderByRank(c("a", "b"), ["gone", "b"]).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("places a card before another, or at the bottom", () => {
    expect(placeCard(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(placeCard(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(placeCard(["a", "b"], "x", "b")).toEqual(["a", "x", "b"]);
    expect(placeCard(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(placeCard(["a", "b"], "x", "missing")).toEqual(["a", "b", "x"]);
  });

  it("keys ranks by dimension so a status 'draft' and a tag 'draft' don't collide", () => {
    expect(rankKey({ dimension: "status" }, "draft")).toBe("status::draft");
    expect(rankKey({ dimension: "tag", tagNamespace: "" }, "draft")).toBe("tag:::draft");
    expect(rankKey({ dimension: "tag", tagNamespace: "stage" }, "draft")).toBe("tag:stage::draft");
  });
});

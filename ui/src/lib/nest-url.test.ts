import { describe, it, expect } from "vitest";
import { documentLink, nestIdFromLocation, nestPath, nestViewFromLocation } from "./nest-url";

describe("nest-url", () => {
  it("reads the nest id from the /nest/<id> path", () => {
    expect(nestIdFromLocation({ pathname: "/nest/abc-123", search: "" })).toBe("abc-123");
    expect(nestIdFromLocation({ pathname: "/nest/abc-123/", search: "?doc=x" })).toBe("abc-123");
  });

  it("still honours the legacy ?nest= query form", () => {
    expect(nestIdFromLocation({ pathname: "/", search: "?nest=abc-123&doc=x" })).toBe("abc-123");
  });

  it("returns null off both forms", () => {
    expect(nestIdFromLocation({ pathname: "/", search: "" })).toBeNull();
    // One view segment is allowed (/nest/<id>/<view>); deeper paths are not a nest.
    expect(nestIdFromLocation({ pathname: "/nest/a/b/c", search: "" })).toBeNull();
  });

  it("keeps a malformed escape as-is instead of throwing", () => {
    expect(nestIdFromLocation({ pathname: "/nest/abc%", search: "" })).toBe("abc%");
    expect(nestIdFromLocation({ pathname: "/nest/a%zz", search: "" })).toBe("a%zz");
  });

  it("round-trips ids that need encoding", () => {
    for (const id of ["a b", "a#b", "a%b", "a/b", "ü"]) {
      expect(nestIdFromLocation({ pathname: nestPath(id), search: "" })).toBe(id);
    }
  });

  it("writes the path form, root when there is no nest", () => {
    expect(nestPath("abc-123")).toBe("/nest/abc-123");
    expect(nestPath(null)).toBe("/");
  });
});

describe("nest-url views", () => {
  it("reads the view segment and writes it back", () => {
    expect(nestViewFromLocation({ pathname: "/nest/abc/board", search: "" })).toBe("board");
    expect(nestViewFromLocation({ pathname: "/nest/abc/board/", search: "" })).toBe("board");
    expect(nestIdFromLocation({ pathname: "/nest/abc/board", search: "" })).toBe("abc");
    expect(nestPath("abc", "board")).toBe("/nest/abc/board");
    expect(nestPath("abc")).toBe("/nest/abc");
  });

  it("still honours the legacy ?view= form and is null without one", () => {
    expect(nestViewFromLocation({ pathname: "/nest/abc", search: "?view=graph" })).toBe("graph");
    expect(nestViewFromLocation({ pathname: "/nest/abc", search: "" })).toBeNull();
    expect(nestViewFromLocation({ pathname: "/", search: "" })).toBeNull();
  });
});

describe("nest-url unknown view segment", () => {
  it("keeps the nest id when the view segment is not one the registry knows", () => {
    const loc = { pathname: "/nest/abc/My_View", search: "" };
    expect(nestIdFromLocation(loc)).toBe("abc");
    expect(nestViewFromLocation(loc)).toBe("My_View");
  });
});

describe("documentLink", () => {
  it("is the nest URL with the node id in ?doc=", () => {
    expect(documentLink("https://nest.acme.dev", "abc-123", "nodes/win-loss-log")).toBe(
      "https://nest.acme.dev/nest/abc-123?doc=nodes%2Fwin-loss-log",
    );
  });

  it("round-trips: the app reads back the same nest and document", () => {
    const url = new URL(documentLink("http://localhost:3000", "a b", "nodes/x y"));
    expect(nestIdFromLocation({ pathname: url.pathname, search: url.search })).toBe("a b");
    expect(new URLSearchParams(url.search).get("doc")).toBe("nodes/x y");
  });
});

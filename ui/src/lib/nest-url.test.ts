import { describe, it, expect } from "vitest";
import { nestIdFromLocation, nestPath } from "./nest-url";

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
    expect(nestIdFromLocation({ pathname: "/nest/a/b", search: "" })).toBeNull();
  });

  it("writes the path form, root when there is no nest", () => {
    expect(nestPath("abc-123")).toBe("/nest/abc-123");
    expect(nestPath(null)).toBe("/");
  });
});

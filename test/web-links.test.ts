/**
 * The one builder for links a PERSON opens (PO-1336). Same route shape the UI
 * writes (ui/src/lib/nest-url.ts): /nest/<id> and /nest/<id>?doc=<node id>.
 */
import { describe, it, expect } from "vitest";
import {
  nestWebPath,
  documentWebPath,
  nestWebUrl,
  documentWebUrl,
} from "../src/shared/web-links";
import { nestPath, documentLink } from "../ui/src/lib/nest-url";

describe("web links", () => {
  it("builds the nest page address", () => {
    expect(nestWebPath("abc-123")).toBe("/nest/abc-123");
    expect(nestWebUrl("https://nest.example.com", "abc-123")).toBe(
      "https://nest.example.com/nest/abc-123",
    );
  });

  it("builds the document address with the node id percent-encoded", () => {
    expect(documentWebPath("abc", "nodes/gtm/q3 plan")).toBe(
      "/nest/abc?doc=nodes%2Fgtm%2Fq3%20plan",
    );
    expect(documentWebUrl("https://nest.example.com", "abc", "nodes/x")).toBe(
      "https://nest.example.com/nest/abc?doc=nodes%2Fx",
    );
  });

  it("writes exactly what the UI writes", () => {
    expect(nestWebPath("a b")).toBe(nestPath("a b"));
    expect(documentWebUrl("https://h", "n1", "nodes/a/b")).toBe(
      documentLink("https://h", "n1", "nodes/a/b"),
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(nestWebUrl("https://h/", "n1")).toBe("https://h/nest/n1");
  });

  it("gives no link when the base is unknown, never a relative one", () => {
    expect(nestWebUrl("", "n1")).toBe("");
    expect(documentWebUrl(undefined, "n1", "nodes/x")).toBe("");
  });
});

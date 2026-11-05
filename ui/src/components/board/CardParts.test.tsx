/** A tag pill must never be wider than the card it sits on. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TagPill } from "./CardParts";

describe("TagPill", () => {
  it.each(["#a-very-long-unbroken-tag-name", "#surface:a-very-long-unbroken-tag-name"])(
    "%s shortens to fit and keeps its full name on hover",
    (tag) => {
      const h = renderToStaticMarkup(<TagPill tag={tag} />);
      expect(h).toContain("max-w-full");
      expect(h).toContain("truncate");
      expect(h).toContain(`title="${tag}"`);
    },
  );
});

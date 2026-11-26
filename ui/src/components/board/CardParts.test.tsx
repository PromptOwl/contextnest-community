/** A tag pill must never be wider than the card it sits on. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentBadge, TagPill, inviteEmail } from "./CardParts";

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

  it("writes the tooltip the same way with or without a leading #", () => {
    expect(renderToStaticMarkup(<TagPill tag="projects" />)).toContain('title="#projects"');
    expect(renderToStaticMarkup(<TagPill tag="#projects" />)).toContain('title="#projects"');
  });
});

// PO-1210: the picker lists members only; a typed email is the way in.
describe("inviteEmail", () => {
  const people = [{ email: "Ada@acme.dev", name: "Ada" }];
  it("offers a full email that is not on the nest", () => {
    expect(inviteEmail(" New@Acme.dev ", people)).toBe("new@acme.dev");
  });
  it("offers nothing for a member, a partial name or a partial email", () => {
    expect(inviteEmail("ada@acme.dev", people)).toBeNull();
    expect(inviteEmail("ada", people)).toBeNull();
    expect(inviteEmail("new@acme", people)).toBeNull();
  });
});

describe("po-1215: CommentBadge", () => {
  const html = (counts?: { open: number; comments: number }) => renderToStaticMarkup(<CommentBadge counts={counts} />);
  it("shows nothing without comments", () => {
    expect(html()).toBe("");
    expect(html({ open: 0, comments: 0 })).toBe("");
  });
  it("shows the count, and says when a thread is unresolved", () => {
    expect(html({ open: 1, comments: 3 })).toContain("3 comments, 1 unresolved thread");
    expect(html({ open: 1, comments: 3 })).toContain("amber");
    expect(html({ open: 0, comments: 1 })).toContain("1 comment, all resolved");
    expect(html({ open: 0, comments: 1 })).not.toContain("amber");
  });
});

import { describe, expect, it } from "vitest";
import { plainExcerpt } from "./plain-excerpt";

describe("My Work mention excerpts read as plain text (PO-1189)", () => {
  const people = [
    { email: "reader@team.test", name: "Rita Reader" },
    { email: "walt@team.test", name: "Walt Writer" },
  ];

  it("drops markdown syntax and keeps the words", () => {
    expect(plainExcerpt("can you sanity-check the **Risks** section and `main`?", [])).toBe("can you sanity-check the Risks section and main?");
    expect(plainExcerpt("## Release checklist\n\n1. **Freeze** the branch\n- [ ] _tag_ it\n> quoted", [])).toBe("Release checklist Freeze the branch tag it quoted");
  });

  it("keeps a link's text, an image's alt and a wikilink's last segment", () => {
    expect(plainExcerpt("see [the guide](https://example.com/g), ![chart](https://example.com/c.png) and [[nodes/plans/q4-roadmap]]", [])).toBe(
      "see the guide, chart and q4-roadmap",
    );
    expect(plainExcerpt("[[nodes/launch-plan|the plan]] is ready", [])).toBe("the plan is ready");
  });

  it("shows a mention by display name when the row names that person, and never a full address", () => {
    expect(plainExcerpt("@reader@team.test can you check? cc @walt@team.test", people)).toBe("@Rita Reader can you check? cc @Walt Writer");
    expect(plainExcerpt("@(Rita Reader) the call moved", people)).toBe("@Rita Reader the call moved");
    // Someone the row does not name: the local part, as the editor shows it.
    expect(plainExcerpt("ask @sam@else.test first", people)).toBe("ask @sam first");
    expect(plainExcerpt("thanks @grok.", people)).toBe("thanks @grok.");
  });

  it("is one line", () => {
    expect(plainExcerpt("line one\n\n\nline   two\t three", [])).toBe("line one line two three");
  });

  it("keeps the text of a code block and plain symbols that are not markup", () => {
    expect(plainExcerpt("```bash\nnpm run build && npm test\n```", [])).toBe("npm run build && npm test");
    expect(plainExcerpt("2 * 3 = 6 and a_b_c stays", [])).toBe("2 * 3 = 6 and a_b_c stays");
    expect(plainExcerpt("", [])).toBe("");
  });
});

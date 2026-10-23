/**
 * Office extraction (src/nodes/office-extract.ts) — pptx slides with titles,
 * text and speaker notes; docx headings, lists and tables; and the refusals
 * an attacker-supplied zip of XML has to hit: not a zip, the wrong package,
 * a DTD/entity, a part that inflates past the cap, too many entries.
 */
import { describe, it, expect } from "vitest";
import {
  extractOffice,
  parseXml,
  OfficeFileError,
  OFFICE_MAX_ENTRIES,
  OFFICE_MAX_XML_BYTES,
} from "../src/nodes/office-extract.js";
import { buildDocx, buildPptx, bombDocx, manyEntriesDocx } from "./office-fixtures.js";

describe("pptx → markdown", () => {
  it("gives one section per slide, in presentation order, with title, text, tables and notes", async () => {
    const deck = await buildPptx(
      [
        { title: "Second in the deck", bullets: ["Beta point"], notes: "Say beta." },
        {
          title: "Q3 Plan",
          bullets: ["Grow revenue", "  Upsell existing accounts", "Hire two engineers"],
          textBox: "Confidential draft",
          notes: "Remember to mention the churn number.\nThen pause for questions.",
        },
        { title: "Numbers", table: [["Region", "Revenue"], ["EMEA", "1.2M | est"]] },
        { bullets: ["An untitled slide"], hidden: true },
      ],
      // slide2.xml is first in the deck, slide1.xml second.
      { order: [2, 1, 3, 4] },
    );
    const out = await extractOffice(deck, "pptx");
    expect(out.kind).toBe("pptx");
    expect(out.slides).toBe(4);
    const md = out.markdown;
    expect(md.indexOf("## Slide 1: Q3 Plan")).toBeGreaterThanOrEqual(0);
    expect(md.indexOf("## Slide 2: Second in the deck")).toBeGreaterThan(md.indexOf("## Slide 1: Q3 Plan"));
    expect(md).toContain("- Grow revenue\n  - Upsell existing accounts\n- Hire two engineers");
    expect(md).toContain("Confidential draft");
    expect(md).toContain("### Speaker notes\n\nRemember to mention the churn number.\n\nThen pause for questions.");
    expect(md).toContain("| Region | Revenue |\n| --- | --- |\n| EMEA | 1.2M \\| est |");
    expect(md).toContain("## Slide 4 (hidden)");
    // Slide-number placeholders are chrome, not content.
    expect(md).not.toMatch(/^\d+$/m);
  });

  it("refuses a docx that claims to be a pptx", async () => {
    const doc = await buildDocx([{ p: "hello" }]);
    await expect(extractOffice(doc, "pptx")).rejects.toThrow(/not a PowerPoint/);
  });
});

describe("docx → markdown", () => {
  it("turns headings, paragraphs, lists and tables into markdown", async () => {
    const doc = await buildDocx([
      { title: "Handbook" },
      { heading: 2, text: "Expenses" },
      { p: "Submit receipts within 30 days." },
      { bullet: "Travel" },
      { bullet: "Lodging", level: 1 },
      { numbered: "First step" },
      { numbered: "Second step" },
      { table: [["Item", "Limit"], ["Meals", "$50"]] },
      { p: "# not a heading, <script>alert(1)</script>" },
    ]);
    const out = await extractOffice(doc, "docx");
    expect(out.kind).toBe("docx");
    const md = out.markdown;
    expect(md).toContain("# Handbook");
    expect(md).toContain("## Expenses");
    expect(md).toContain("Submit receipts within 30 days.");
    expect(md).toContain("- Travel\n  - Lodging\n1. First step\n1. Second step");
    expect(md).toContain("| Item | Limit |\n| --- | --- |\n| Meals | $50 |");
    // Text that looks like markdown or HTML stays text.
    expect(md).toContain("\\# not a heading, \\<script>alert(1)\\</script>");
  });

  it("skips deleted tracked changes and field codes", async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = await buildDocx([], {
      documentXml:
        `<w:document ${W}><w:body><w:p><w:r><w:t>kept</w:t></w:r>` +
        `<w:del><w:r><w:delText>removed</w:delText></w:r></w:del>` +
        `<w:r><w:instrText> PAGE </w:instrText></w:r></w:p></w:body></w:document>`,
    });
    const md = (await extractOffice(doc, "docx")).markdown;
    expect(md).toBe("kept");
  });
});

describe("refusals", () => {
  it("refuses something that is not a zip (a renamed .exe)", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(64).fill(0)]);
    await expect(extractOffice(exe, "pptx")).rejects.toBeInstanceOf(OfficeFileError);
  });

  it("refuses an XML part with a DTD — entities are never expanded", async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = await buildDocx([], {
      documentXml:
        `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>` +
        `<w:document ${W}><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>`,
    });
    await expect(extractOffice(doc, "docx")).rejects.toThrow(/document type declaration/);
  });

  it("leaves an undeclared entity as literal text", () => {
    const el = parseXml("<a>x &ent; &lt;y&gt; &#65;</a>");
    expect(el.children).toEqual(["x &ent; <y> A"]);
  });

  it("refuses a part that inflates past the XML cap (zip bomb), without inflating it all", async () => {
    const bomb = await bombDocx(OFFICE_MAX_XML_BYTES + 1024 * 1024);
    // The bomb is small on the wire — that is the point of one.
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(extractOffice(bomb, "docx")).rejects.toThrow(/too large/);
  });

  it("still stops inflating when the central directory lies about the size", async () => {
    const bomb = await bombDocx(OFFICE_MAX_XML_BYTES + 1024 * 1024);
    // Rewrite every central-directory entry's uncompressed size (offset 24)
    // to 1 KB, so only the streaming cap can catch the part.
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
    let patched = 0;
    for (let p = 0; p + 46 <= bomb.length; p++) {
      if (view.getUint32(p, true) === 0x02014b50) {
        view.setUint32(p + 24, 1024, true);
        patched++;
      }
    }
    expect(patched).toBeGreaterThan(0);
    await expect(extractOffice(bomb, "docx")).rejects.toThrow(/too large/);
  });

  it("refuses a package with more entries than the cap", async () => {
    const many = await manyEntriesDocx(OFFICE_MAX_ENTRIES + 1);
    await expect(extractOffice(many, "docx")).rejects.toThrow(/too many parts/);
  });

  it("refuses malformed XML", async () => {
    const doc = await buildDocx([], { documentXml: "<w:document><w:body><w:p></w:body>" });
    await expect(extractOffice(doc, "docx")).rejects.toThrow(/Malformed XML/);
  });
});

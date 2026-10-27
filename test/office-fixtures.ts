/**
 * Minimal .pptx / .docx packages for the Office-document tests, built with
 * jszip at test time so no binary fixtures are checked in. Only the parts the
 * extractor reads are written (plus [Content_Types].xml) — enough for the
 * extractor, not for PowerPoint/Word to open them.
 */
import JSZip from "jszip";

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

export interface FixtureSlide {
  title?: string;
  /** Body placeholder paragraphs; a leading "  " per indent level. */
  bullets?: string[];
  /** A free text box (not a placeholder). */
  textBox?: string;
  table?: string[][];
  notes?: string;
  hidden?: boolean;
}

function paragraphs(lines: string[]): string {
  return lines
    .map((l) => {
      const lvl = (l.match(/^ */)![0].length / 2) | 0;
      return `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:rPr lang="en-US"/><a:t>${esc(l.trim())}</a:t></a:r></a:p>`;
    })
    .join("");
}

function shape(ph: string | null, lines: string[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ""}</p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${paragraphs(lines)}</p:txBody></p:sp>`
  );
}

function slideXml(s: FixtureSlide, n: number): string {
  let tree = "";
  if (s.title !== undefined) tree += shape("title", [s.title]);
  if (s.bullets) tree += shape("body", s.bullets);
  if (s.textBox) tree += shape(null, [s.textBox]);
  if (s.table) {
    tree +=
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<a:graphic><a:graphicData><a:tbl>` +
      s.table
        .map((row) => `<a:tr>${row.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${esc(c)}</a:t></a:r></a:p></a:txBody></a:tc>`).join("")}</a:tr>`)
        .join("") +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  }
  // Slide-number chrome must not show up in the text.
  tree += shape("sldNum", [String(n)]);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P} ${A} ${R}${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${P} ${A} ${R}><p:cSld><p:spTree>` +
    shape("sldImg", []) +
    shape("body", text.split("\n")) +
    `</p:spTree></p:cSld></p:notes>`
  );
}

/**
 * A deck. `order` lists slide file numbers in presentation order (default
 * 1..n) — the extractor must follow sldIdLst, not file names.
 */
export async function buildPptx(slides: FixtureSlide[], opts: { order?: number[] } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  const order = opts.order ?? slides.map((_, i) => i + 1);
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P} ${R}><p:sldIdLst>` +
      order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join("") +
      `</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` +
      slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
      `</Relationships>`,
  );
  slides.forEach((s, i) => {
    const n = i + 1;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(s, n));
    if (s.notes !== undefined) {
      zip.file(
        `ppt/slides/_rels/slide${n}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` +
          `<Relationship Id="rId1" Type="${REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`,
      );
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(s.notes));
    }
  });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export type DocxBlock =
  | { heading: number; text: string }
  | { title: string }
  | { p: string }
  | { bullet: string; level?: number }
  | { numbered: string }
  | { table: string[][] }
  | { raw: string };

function wordRun(text: string): string {
  return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function blockXml(b: DocxBlock): string {
  if ("heading" in b) return `<w:p><w:pPr><w:pStyle w:val="Heading${b.heading}"/></w:pPr>${wordRun(b.text)}</w:p>`;
  if ("title" in b) return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${wordRun(b.title)}</w:p>`;
  if ("p" in b) return `<w:p>${wordRun(b.p)}</w:p>`;
  if ("bullet" in b) {
    return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${b.level ?? 0}"/><w:numId w:val="1"/></w:numPr></w:pPr>${wordRun(b.bullet)}</w:p>`;
  }
  if ("numbered" in b) {
    return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${wordRun(b.numbered)}</w:p>`;
  }
  if ("table" in b) {
    return (
      `<w:tbl><w:tblPr/>` +
      b.table.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p>${wordRun(c)}</w:p></w:tc>`).join("")}</w:tr>`).join("") +
      `</w:tbl>`
    );
  }
  return b.raw;
}

const NUMBERING =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

/** A Word document from blocks, or from a raw document.xml when given. */
export async function buildDocx(blocks: DocxBlock[], opts: { documentXml?: string } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file(
    "word/document.xml",
    opts.documentXml ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} ${R}><w:body>` +
        blocks.map(blockXml).join("") +
        `<w:sectPr/></w:body></w:document>`,
  );
  zip.file("word/numbering.xml", NUMBERING);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A docx whose document.xml inflates past `bytes` (a zip bomb, ~1000:1). */
export async function bombDocx(bytes: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  const pad = " ".repeat(bytes);
  zip.file("word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p>${pad}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

/** A zip with `count` tiny entries besides a valid docx's parts. */
export async function manyEntriesDocx(count: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`);
  for (let i = 0; i < count; i++) zip.file(`junk/${i}.txt`, "");
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

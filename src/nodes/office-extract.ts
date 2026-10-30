/**
 * Office files (pptx / docx / xlsx) → markdown, for the governed-document upload
 * (office-routes.ts).
 *
 * An Office file is an attacker-controlled zip of XML, so everything here is
 * written to refuse rather than to cope:
 *
 *   - Zip bombs. The entry count is read from the end-of-central-directory
 *     record BEFORE JSZip builds an object per entry, and zip64 (the only way
 *     past 65,535 entries) is refused. Only the XML parts the text comes from
 *     are ever inflated — media is never touched — and each one is streamed
 *     and torn down once the running total passes OFFICE_MAX_XML_BYTES, so a
 *     part that lies about its size in the central directory still can't
 *     inflate past the cap.
 *   - XML entities. The parser below is a small tokenizer that never resolves
 *     an entity: a document carrying a DTD (`<!DOCTYPE`, `<!ENTITY`) is
 *     refused outright — no Office part has one — and only the five
 *     predefined entities and numeric character references are decoded.
 *     Anything else stays literal text. No external fetch is possible.
 *   - Size of the tree. Elements are counted against OFFICE_MAX_ELEMENTS and
 *     nesting against OFFICE_MAX_DEPTH while parsing, so a pathological part
 *     fails fast instead of exhausting memory or the stack.
 *
 * Every refusal is an OfficeFileError, which the routes turn into a 400 with
 * nothing written.
 */
import JSZip from "jszip";

/** Most entries a zip may declare. Real decks with hundreds of slides and
 *  their media stay well under this. */
export const OFFICE_MAX_ENTRIES = 10_000;
/** Most XML (inflated) read from one file, summed over the parts used. */
export const OFFICE_MAX_XML_BYTES = 32 * 1024 * 1024;
/** Most XML elements parsed from one file, summed over the parts used. */
export const OFFICE_MAX_ELEMENTS = 500_000;
/** Deepest element nesting accepted in a part. */
export const OFFICE_MAX_DEPTH = 256;

export type OfficeKind = "pptx" | "docx" | "xlsx";

export class OfficeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficeFileError";
  }
}

export interface OfficeExtraction {
  kind: OfficeKind;
  /** The markdown body, without the provenance line the caller adds. */
  markdown: string;
  /** Slides for a deck; undefined otherwise. */
  slides?: number;
  /** Sheets for a workbook; undefined otherwise. */
  sheets?: number;
}

// ─── Minimal non-resolving XML parser ──────────────────────────────────────

export interface XmlElement {
  /** Local name, prefix stripped ("w:p" → "p"). */
  name: string;
  /** Attributes as written, prefixed names kept ("r:id"). */
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

interface Budget {
  xmlBytes: number;
  elements: number;
}

const PREDEFINED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Decode the predefined entities and numeric references; leave the rest. */
function decodeText(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Lone surrogates and out-of-range code points are not characters.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return PREDEFINED[ref] ?? whole;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

// Sticky, from the end of the tag name: one attempt per attribute, and the
// first miss ends the tag. A global regex retried at every offset, which is
// quadratic on a long run with no `=` (a 1 MB tag zips to ~1 KB).
const ATTR = /\s+([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Parse one XML part into a light tree. Throws OfficeFileError on a DTD,
 * malformed markup, or a budget overrun. `budget` is shared across the parts
 * of one file.
 */
export function parseXml(text: string, budget: Budget = { xmlBytes: 0, elements: 0 }): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      if (stack.length > 1) stack[stack.length - 1].children.push(decodeText(text.slice(i)));
      break;
    }
    if (lt > i && stack.length > 1) {
      stack[stack.length - 1].children.push(decodeText(text.slice(i, lt)));
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw new OfficeFileError("Malformed XML (unterminated processing instruction).");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw new OfficeFileError("Malformed XML (unterminated comment).");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw new OfficeFileError("Malformed XML (unterminated CDATA).");
      if (stack.length > 1) stack[stack.length - 1].children.push(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // <!DOCTYPE / <!ENTITY: the only way to declare an entity. Refused —
      // there is nothing in an Office part that needs one.
      throw new OfficeFileError("The file contains an XML document type declaration (DTD), which is not allowed.");
    }
    // A tag. Find its '>' outside quoted attribute values.
    let j = lt + 1;
    let quote = "";
    for (; j < n; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (j >= n) throw new OfficeFileError("Malformed XML (unterminated tag).");
    const inner = text.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === "/") {
      const name = localName(inner.slice(1).trim());
      const open = stack.pop();
      if (!open || open === root || open.name !== name) {
        throw new OfficeFileError("Malformed XML (mismatched closing tag).");
      }
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new OfficeFileError("Malformed XML (empty tag).");
    if (++budget.elements > OFFICE_MAX_ELEMENTS) {
      throw new OfficeFileError(`The file has too many XML elements (more than ${OFFICE_MAX_ELEMENTS}).`);
    }
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = m[1].length;
    for (let a = ATTR.exec(body); a; a = ATTR.exec(body)) {
      attrs[a[1]] = decodeText(a[2] ?? a[3] ?? "");
    }
    const el: XmlElement = { name: localName(m[1]), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) {
      if (stack.length > OFFICE_MAX_DEPTH) {
        throw new OfficeFileError(`The file nests XML deeper than ${OFFICE_MAX_DEPTH} levels.`);
      }
      stack.push(el);
    }
  }
  if (stack.length !== 1) throw new OfficeFileError("Malformed XML (unclosed element).");
  const top = root.children.find((c): c is XmlElement => typeof c !== "string");
  if (!top) throw new OfficeFileError("Malformed XML (no root element).");
  return top;
}

/** An attribute by local name; an unprefixed one wins over a prefixed one. */
function attr(el: XmlElement, local: string): string | undefined {
  if (el.attrs[local] !== undefined) return el.attrs[local];
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === local) return v;
  return undefined;
}

/** A prefixed attribute only (`r:id`, never the bare `id` beside it). */
function prefixedAttr(el: XmlElement, local: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k.includes(":") && localName(k) === local && !k.startsWith("xmlns")) return v;
  }
  return undefined;
}

function kids(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => typeof c !== "string" && (name === undefined || c.name === name),
  );
}

function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el ? kids(el, name)[0] : undefined;
}

/** First descendant with this name (depth-first, document order). */
function find(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of kids(el)) {
    if (c.name === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

function findAll(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of kids(el)) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

// ─── Zip access with the bomb guards ───────────────────────────────────────

/** Entry count from the end-of-central-directory record, read before JSZip
 *  allocates an object per entry. Null when there is no EOCD (not a zip). */
function declaredEntryCount(bytes: Uint8Array): number | null {
  // EOCD is 22 bytes plus a comment of at most 65,535.
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let p = bytes.length - 22; p >= stop; p--) {
    if (bytes[p] === 0x50 && bytes[p + 1] === 0x4b && bytes[p + 2] === 0x05 && bytes[p + 3] === 0x06) {
      return bytes[p + 10] | (bytes[p + 11] << 8);
    }
  }
  return null;
}

class OfficeZip {
  private constructor(
    private readonly zip: JSZip,
    private readonly budget: Budget,
  ) {}

  static async open(bytes: Uint8Array): Promise<OfficeZip> {
    // A zip starts with a local file header ("PK\x03\x04"). A renamed .exe,
    // a legacy .ppt/.doc (OLE compound file) or anything else stops here.
    if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new OfficeFileError("That file is not a .pptx, .docx or .xlsx (it is not a zip package).");
    }
    const entries = declaredEntryCount(bytes);
    if (entries === null) throw new OfficeFileError("That file is not a readable zip package.");
    // 0xFFFF means "see the zip64 record" — the only way to declare more.
    if (entries === 0xffff || entries > OFFICE_MAX_ENTRIES) {
      throw new OfficeFileError(`The file has too many parts (more than ${OFFICE_MAX_ENTRIES}).`);
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new OfficeFileError("That file is not a readable zip package.");
    }
    if (Object.keys(zip.files).length > OFFICE_MAX_ENTRIES) {
      throw new OfficeFileError(`The file has too many parts (more than ${OFFICE_MAX_ENTRIES}).`);
    }
    return new OfficeZip(zip, { xmlBytes: 0, elements: 0 });
  }

  has(path: string): boolean {
    const f = this.zip.file(path);
    return !!f && !f.dir;
  }

  /** Inflate one part as text, capped against the file's running total. */
  private async text(path: string): Promise<string> {
    const f = this.zip.file(path);
    if (!f || f.dir) throw new OfficeFileError(`The file is missing a required part (${path}).`);
    const remaining = OFFICE_MAX_XML_BYTES - this.budget.xmlBytes;
    // Cheap early refusal on the size the central directory declares (JSZip
    // keeps it on the private _data). It can lie — the stream below is the
    // real gate.
    const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declared === "number" && declared > remaining) throw this.tooBig();
    const chunks: Buffer[] = [];
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = f.nodeStream("nodebuffer");
      stream.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > remaining) {
          (stream as unknown as { destroy?: () => void }).destroy?.();
          reject(this.tooBig());
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", () => reject(new OfficeFileError(`The file has a corrupt part (${path}).`)));
      stream.on("end", () => resolve());
    });
    this.budget.xmlBytes += seen;
    return Buffer.concat(chunks).toString("utf8");
  }

  private tooBig(): OfficeFileError {
    return new OfficeFileError(
      `The file's text content is too large to import (more than ${OFFICE_MAX_XML_BYTES / (1024 * 1024)} MB of XML once unzipped).`,
    );
  }

  async xml(path: string): Promise<XmlElement> {
    return parseXml(await this.text(path), this.budget);
  }

  async optionalXml(path: string): Promise<XmlElement | null> {
    return this.has(path) ? this.xml(path) : null;
  }

  /** A part's relationships: rId → { target (resolved to a zip path), type }. */
  async rels(partPath: string): Promise<Map<string, { target: string; type: string }>> {
    const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/")) : "";
    const leaf = partPath.slice(partPath.lastIndexOf("/") + 1);
    const relsPath = `${dir ? `${dir}/` : ""}_rels/${leaf}.rels`;
    const out = new Map<string, { target: string; type: string }>();
    const doc = await this.optionalXml(relsPath);
    if (!doc) return out;
    for (const r of kids(doc, "Relationship")) {
      const id = attr(r, "Id");
      const target = attr(r, "Target");
      if (!id || !target || attr(r, "TargetMode") === "External") continue;
      out.set(id, { target: resolvePartPath(dir, target), type: attr(r, "Type") ?? "" });
    }
    return out;
  }
}

/** Resolve a relationship target against the source part's folder. Only ever
 *  used to look a name up inside the zip, never as a filesystem path. */
function resolvePartPath(baseDir: string, target: string): string {
  const parts = target.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

// ─── Markdown helpers ──────────────────────────────────────────────────────

/** Keep extracted text from being read as markdown block syntax, HTML, or a
 *  link, image or wikilink (`[` — backslashes first, so `\[` can't unescape). */
function escapeLine(s: string): string {
  return s
    .replace(/[\\[]/g, "\\$&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|~~~)/, "$1\\$2");
}

function cleanSpaces(s: string): string {
  return s.replace(/[\t ]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  if (width === 0) return "";
  const cell = (s: string) => escapeLine(s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ") || " ";
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => cell(r[k] ?? "")).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

// ─── pptx ──────────────────────────────────────────────────────────────────

/** Text of a DrawingML paragraph (<a:p>): runs, fields and line breaks. */
function drawingParagraph(p: XmlElement): string {
  let out = "";
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      if (c.name === "t") out += c.children.filter((x): x is string => typeof x === "string").join("");
      else if (c.name === "br") out += "\n";
      else if (c.name !== "pPr" && c.name !== "rPr" && c.name !== "endParaRPr") walk(c);
    }
  };
  walk(p);
  return out
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)
    .join(" ");
}

function placeholderType(sp: XmlElement): string | null {
  const ph = find(child(sp, "nvSpPr") ?? sp, "ph");
  if (!ph) return null;
  return attr(ph, "type") ?? "body";
}

/** A shape's paragraphs as markdown lines (bullets where the slide has them). */
function shapeLines(txBody: XmlElement, bulletsByDefault: boolean): string[] {
  const lines: string[] = [];
  for (const p of kids(txBody, "p")) {
    const text = drawingParagraph(p);
    if (!text) continue;
    const pPr = child(p, "pPr");
    const lvl = Math.min(8, Number(pPr ? attr(pPr, "lvl") ?? 0 : 0) || 0);
    const explicitNone = !!(pPr && child(pPr, "buNone"));
    const explicitBullet = !!(pPr && (child(pPr, "buChar") || child(pPr, "buAutoNum")));
    const bullet = explicitBullet || (bulletsByDefault && !explicitNone);
    lines.push(bullet ? `${"  ".repeat(lvl)}- ${escapeLine(text)}` : escapeLine(text));
  }
  return lines;
}

function drawingTable(tbl: XmlElement): string {
  const rows = kids(tbl, "tr").map((tr) =>
    kids(tr, "tc").map((tc) =>
      findAll(tc, "p")
        .map(drawingParagraph)
        .filter(Boolean)
        .join(" "),
    ),
  );
  return rows.length ? markdownTable(rows) : "";
}

interface SlideContent {
  title: string;
  blocks: string[];
}

function slideContent(tree: XmlElement): SlideContent {
  const spTree = find(tree, "spTree");
  const out: SlideContent = { title: "", blocks: [] };
  if (!spTree) return out;
  const visit = (container: XmlElement) => {
    for (const el of kids(container)) {
      if (el.name === "grpSp") visit(el);
      else if (el.name === "graphicFrame") {
        const tbl = find(el, "tbl");
        const md = tbl ? drawingTable(tbl) : "";
        if (md) out.blocks.push(md);
      } else if (el.name === "sp") {
        const txBody = child(el, "txBody");
        if (!txBody) continue;
        const ph = placeholderType(el);
        if ((ph === "title" || ph === "ctrTitle") && !out.title) {
          out.title = kids(txBody, "p").map(drawingParagraph).filter(Boolean).join(" ");
          continue;
        }
        // Footer, date and slide-number placeholders are chrome, not content.
        if (ph === "dt" || ph === "ftr" || ph === "sldNum" || ph === "hdr") continue;
        const bullets = ph === "body" || ph === "obj";
        const lines = shapeLines(txBody, bullets);
        if (lines.length) out.blocks.push(lines.join("\n"));
      } else if (el.name === "AlternateContent") {
        // Markup-compatibility: the Choice and the Fallback carry the same
        // content; read one.
        const pick = child(el, "Choice") ?? child(el, "Fallback");
        if (pick) visit(pick);
      }
    }
  };
  visit(spTree);
  return out;
}

function notesText(tree: XmlElement): string {
  const spTree = find(tree, "spTree");
  if (!spTree) return "";
  const lines: string[] = [];
  for (const sp of findAll(spTree, "sp")) {
    if (placeholderType(sp) !== "body") continue;
    const txBody = child(sp, "txBody");
    if (txBody) lines.push(...shapeLines(txBody, false));
  }
  return lines.join("\n\n");
}

async function extractPptx(zip: OfficeZip): Promise<OfficeExtraction> {
  const presentation = await zip.xml("ppt/presentation.xml");
  const rels = await zip.rels("ppt/presentation.xml");
  const order = kids(child(presentation, "sldIdLst") ?? presentation, "sldId");
  const sections: string[] = [];
  let n = 0;
  for (const sldId of order) {
    const rid = prefixedAttr(sldId, "id");
    const rel = rid ? rels.get(rid) : undefined;
    if (!rel || !zip.has(rel.target)) continue;
    n++;
    const slide = await zip.xml(rel.target);
    const { title, blocks } = slideContent(slide);
    const hidden = attr(slide, "show") === "0" ? " (hidden)" : "";
    const heading = `## Slide ${n}${title ? `: ${escapeLine(cleanSpaces(title))}` : ""}${hidden}`;
    const parts = [heading, ...blocks];
    const slideRels = await zip.rels(rel.target);
    const notesRel = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"));
    if (notesRel && zip.has(notesRel.target)) {
      const notes = notesText(await zip.xml(notesRel.target));
      if (notes) parts.push("### Speaker notes", notes);
    }
    sections.push(parts.join("\n\n"));
  }
  return {
    kind: "pptx",
    markdown: sections.length ? sections.join("\n\n") : "_This presentation has no slides._",
    slides: n,
  };
}

// ─── docx ──────────────────────────────────────────────────────────────────

interface DocxStyles {
  /** styleId → heading level (1-6). */
  headings: Map<string, number>;
}

function headingLevelFromName(name: string): number | null {
  const s = name.trim().toLowerCase();
  if (s === "title") return 1;
  const m = /^heading\s*([1-9])$/.exec(s);
  return m ? Math.min(6, Number(m[1])) : null;
}

function readStyles(tree: XmlElement | null): DocxStyles {
  const headings = new Map<string, number>();
  if (!tree) return { headings };
  for (const style of kids(tree, "style")) {
    const id = attr(style, "styleId");
    if (!id) continue;
    const name = attr(child(style, "name") ?? style, "val") ?? "";
    let level = headingLevelFromName(name);
    const outline = child(child(style, "pPr"), "outlineLvl");
    if (level === null && outline) {
      const lvl = Number(attr(outline, "val"));
      if (Number.isInteger(lvl) && lvl >= 0 && lvl < 9) level = Math.min(6, lvl + 1);
    }
    if (level !== null) headings.set(id, level);
  }
  return { headings };
}

/** numId → ilvl → ordered? (from numbering.xml). */
function readNumbering(tree: XmlElement | null): Map<string, Map<string, boolean>> {
  const out = new Map<string, Map<string, boolean>>();
  if (!tree) return out;
  const abstract = new Map<string, Map<string, boolean>>();
  for (const a of kids(tree, "abstractNum")) {
    const levels = new Map<string, boolean>();
    for (const lvl of kids(a, "lvl")) {
      const fmt = attr(child(lvl, "numFmt") ?? lvl, "val") ?? "bullet";
      levels.set(attr(lvl, "ilvl") ?? "0", fmt !== "bullet" && fmt !== "none");
    }
    const id = attr(a, "abstractNumId");
    if (id !== undefined) abstract.set(id, levels);
  }
  for (const num of kids(tree, "num")) {
    const id = attr(num, "numId");
    const abs = attr(child(num, "abstractNumId") ?? num, "val");
    if (id !== undefined && abs !== undefined && abstract.has(abs)) out.set(id, abstract.get(abs)!);
  }
  return out;
}

/** Text of a WordprocessingML paragraph: visible runs only. */
function wordParagraph(p: XmlElement): string {
  let out = "";
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      switch (c.name) {
        case "t":
          out += c.children.filter((x): x is string => typeof x === "string").join("");
          break;
        case "tab":
          out += " ";
          break;
        case "br":
        case "cr":
          out += "\n";
          break;
        case "noBreakHyphen":
          out += "-";
          break;
        // Deleted tracked changes, field codes, run/paragraph properties and
        // the duplicate fallback of markup-compatibility blocks are not text.
        case "del":
        case "delText":
        case "instrText":
        case "pPr":
        case "rPr":
        case "Fallback":
          break;
        default:
          walk(c);
      }
    }
  };
  walk(p);
  return out
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)
    .join("\n");
}

function wordBlocks(
  container: XmlElement,
  styles: DocxStyles,
  numbering: Map<string, Map<string, boolean>>,
  out: string[],
): void {
  for (const el of kids(container)) {
    if (el.name === "p") {
      const text = wordParagraph(el);
      if (!text) continue;
      const pPr = child(el, "pPr");
      const pStyle = child(pPr, "pStyle");
      const styleId = pStyle ? attr(pStyle, "val") : undefined;
      // A style id the styles part doesn't define still reads as a heading
      // when it is the built-in name ("Heading2", "Title").
      let level = styleId
        ? (styles.headings.get(styleId) ?? headingLevelFromName(styleId.replace(/(\d)$/, " $1")))
        : null;
      const outline = child(pPr, "outlineLvl");
      if (level === null && outline) {
        const lvl = Number(attr(outline, "val"));
        if (Number.isInteger(lvl) && lvl >= 0 && lvl < 9) level = Math.min(6, lvl + 1);
      }
      if (level !== null) {
        out.push(`${"#".repeat(level)} ${escapeLine(text.replace(/\n/g, " "))}`);
        continue;
      }
      const numPr = child(pPr, "numPr");
      const numId = numPr ? attr(child(numPr, "numId") ?? numPr, "val") : undefined;
      if (numPr && numId && numId !== "0") {
        const ilvl = attr(child(numPr, "ilvl") ?? numPr, "val") ?? "0";
        const depth = Math.min(8, Number(ilvl) || 0);
        const ordered = numbering.get(numId)?.get(ilvl) ?? false;
        const marker = ordered ? "1." : "-";
        // Consecutive list items stay one list: mark them so the joiner
        // below doesn't put a blank line between them.
        out.push(`\u0000${"  ".repeat(depth)}${marker} ${escapeLine(text.replace(/\n/g, " "))}`);
        continue;
      }
      out.push(text.split("\n").map(escapeLine).join("  \n"));
    } else if (el.name === "tbl") {
      const rows = kids(el, "tr").map((tr) =>
        kids(tr, "tc").map((tc) =>
          findAll(tc, "p")
            .map(wordParagraph)
            .filter(Boolean)
            .join(" ")
            .replace(/\n/g, " "),
        ),
      );
      const md = rows.length ? markdownTable(rows) : "";
      if (md) out.push(md);
    } else if (el.name === "sectPr" || el.name === "Fallback") {
      continue;
    } else {
      // Content controls (sdt/sdtContent), custom XML, tracked insertions and
      // the like wrap ordinary paragraphs and tables.
      wordBlocks(el, styles, numbering, out);
    }
  }
}

async function extractDocx(zip: OfficeZip): Promise<OfficeExtraction> {
  const document = await zip.xml("word/document.xml");
  const styles = readStyles(await zip.optionalXml("word/styles.xml"));
  const numbering = readNumbering(await zip.optionalXml("word/numbering.xml"));
  const body = child(document, "body");
  const blocks: string[] = [];
  if (body) wordBlocks(body, styles, numbering, blocks);
  let markdown = "";
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const isItem = b.startsWith("\u0000");
    const prevItem = k > 0 && blocks[k - 1].startsWith("\u0000");
    markdown += (k === 0 ? "" : isItem && prevItem ? "\n" : "\n\n") + (isItem ? b.slice(1) : b);
  }
  return { kind: "docx", markdown: markdown || "_No text was found in this document._" };
}

// ─── xlsx ──────────────────────────────────────────────────────────────────

/** Rows and columns shown per sheet; the rest is counted in a note. */
export const XLSX_MAX_ROWS = 500;
export const XLSX_MAX_COLS = 50;

/** All text below an element (a shared string's runs, an inline string). */
function textOf(el: XmlElement): string {
  return el.children.map((c) => (typeof c === "string" ? c : c.name === "rPh" ? "" : textOf(c))).join("");
}

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell styles (cellXfs index) format their number as a date. */
function dateStyles(styles: XmlElement | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const f of kids(child(styles, "numFmts") ?? styles, "numFmt")) {
    custom.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "");
  }
  // A custom format is a date when d/m/y/h appear outside quotes and [colour] tags.
  const isDate = (code: string) => /[dmyh]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
  kids(child(styles, "cellXfs") ?? styles, "xf").forEach((xf, i) => {
    const id = Number(attr(xf, "numFmtId") ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDate(custom.get(id)!))) out.add(i);
  });
  return out;
}

/** Excel serial day → ISO date (with HH:MM when it has a time part). */
function serialDate(serial: number, date1904: boolean): string {
  // Day 25569 is 1970-01-01 in the 1900 system; the 1904 system is 1462 days later.
  const iso = new Date(Math.round((serial - (date1904 ? 24107 : 25569)) * 86_400_000)).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** "BC12" → 54 (0-based column), or null. */
function columnIndex(ref: string | undefined): number | null {
  const letters = ref?.match(/^[A-Z]+/)?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellValue(c: XmlElement, shared: string[], dates: Set<number>, date1904: boolean): string {
  const type = attr(c, "t") ?? "n";
  if (type === "inlineStr") return cleanSpaces(textOf(child(c, "is") ?? c));
  const v = child(c, "v");
  const raw = v ? textOf(v) : "";
  if (raw === "") return "";
  if (type === "s") return cleanSpaces(shared[Number(raw)] ?? "");
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "n" && dates.has(Number(attr(c, "s") ?? -1))) {
    const n = Number(raw);
    if (Number.isFinite(n)) return serialDate(n, date1904);
  }
  return cleanSpaces(raw);
}

function sheetSection(name: string, sheet: XmlElement, shared: string[], dates: Set<number>, date1904: boolean): string {
  const rows: string[][] = [];
  for (const row of kids(child(sheet, "sheetData") ?? sheet, "row")) {
    const cells: string[] = [];
    let next = 0;
    for (const c of kids(row, "c")) {
      const col = columnIndex(attr(c, "r")) ?? next;
      next = col + 1;
      cells[col] = cellValue(c, shared, dates, date1904);
    }
    if (cells.some((s) => s)) rows.push(Array.from(cells, (s) => s ?? ""));
  }
  const heading = `## Sheet: ${escapeLine(cleanSpaces(name))}`;
  if (!rows.length) return `${heading}\n\n_Empty sheet._`;
  const width = Math.max(...rows.map((r) => r.length));
  const shown = rows.slice(0, XLSX_MAX_ROWS + 1).map((r) => r.slice(0, XLSX_MAX_COLS));
  const cut: string[] = [];
  // The header row is not counted against the row cap.
  if (rows.length - 1 > XLSX_MAX_ROWS) cut.push(`the first ${XLSX_MAX_ROWS} of ${rows.length - 1} rows`);
  if (width > XLSX_MAX_COLS) cut.push(`the first ${XLSX_MAX_COLS} of ${width} columns`);
  const note = cut.length ? `\n\n_Truncated: showing ${cut.join(" and ")}._` : "";
  return `${heading}\n\n${markdownTable(shown)}${note}`;
}

async function extractXlsx(zip: OfficeZip): Promise<OfficeExtraction> {
  const workbook = await zip.xml("xl/workbook.xml");
  const rels = await zip.rels("xl/workbook.xml");
  const date1904 = ["1", "true"].includes(attr(child(workbook, "workbookPr") ?? workbook, "date1904") ?? "");
  const sharedXml = await zip.optionalXml("xl/sharedStrings.xml");
  const shared = sharedXml ? kids(sharedXml, "si").map(textOf) : [];
  const dates = dateStyles(await zip.optionalXml("xl/styles.xml"));
  const sections: string[] = [];
  for (const s of kids(child(workbook, "sheets") ?? workbook, "sheet")) {
    const rid = prefixedAttr(s, "id");
    const rel = rid ? rels.get(rid) : undefined;
    // Chart sheets and dialog sheets have no cell grid.
    if (!rel || !rel.type.endsWith("/worksheet") || !zip.has(rel.target)) continue;
    sections.push(sheetSection(attr(s, "name") ?? `Sheet ${sections.length + 1}`, await zip.xml(rel.target), shared, dates, date1904));
  }
  return {
    kind: "xlsx",
    markdown: sections.length ? sections.join("\n\n") : "_This workbook has no sheets._",
    sheets: sections.length,
  };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Extract a pptx, docx or xlsx. `kind` is what the file name claims; the package
 * has to agree (a docx renamed .pptx is refused, not guessed at).
 */
export async function extractOffice(bytes: Uint8Array, kind: OfficeKind): Promise<OfficeExtraction> {
  const zip = await OfficeZip.open(bytes);
  if (kind === "pptx") {
    if (!zip.has("ppt/presentation.xml")) {
      throw new OfficeFileError("That file is not a PowerPoint presentation (.pptx).");
    }
    return extractPptx(zip);
  }
  if (kind === "xlsx") {
    if (!zip.has("xl/workbook.xml")) {
      throw new OfficeFileError("That file is not an Excel workbook (.xlsx).");
    }
    return extractXlsx(zip);
  }
  if (!zip.has("word/document.xml")) {
    throw new OfficeFileError("That file is not a Word document (.docx).");
  }
  return extractDocx(zip);
}

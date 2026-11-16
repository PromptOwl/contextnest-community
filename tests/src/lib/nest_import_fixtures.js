/**
 * Nest Import Fixtures — the files and the vault folder the Nest Import suite
 * picks in the nest's "Import into this nest" dialog.
 *
 * Single files are built in memory as Playwright file payloads
 * ({ name, mimeType, buffer }), so nothing touches the disk. The vault is a
 * real folder (Whole vault picks a directory), built at run time inside the
 * test's own output folder (tests/test-results, gitignored).
 */

import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

/** A Markdown file. */
export function markdownFile(name, body) {
  return { name, mimeType: 'text/markdown', buffer: Buffer.from(body) };
}

/** An HTML file — imported as an Artifact. */
export function htmlFile(name, body) {
  return { name, mimeType: 'text/html', buffer: Buffer.from(body) };
}

/** A plain-text file — imported as a document. */
export function textFile(name, body) {
  return { name, mimeType: 'text/plain', buffer: Buffer.from(body) };
}

/** A PNG file — a type the import doesn't support. */
export function pngFile(name) {
  return { name, mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
}

/** A one-page PDF whose page carries `text` as real, extractable text. */
export function pdfFile(name, text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'latin1') };
}

/** A minimal Word (.docx) file with one paragraph of `text`. */
export async function docxFile(name, text) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  };
}

/**
 * A vault folder: two documents in folders ("guides", "Team Notes") and one
 * in a hidden folder the import skips.
 * @returns {string} absolute path of the folder
 */
export function buildVault(baseDir, name = 'vault') {
  const root = path.join(baseDir, name);
  const files = {
    'guides/setup.md': '# Setup\n\nSetup steps.\n',
    'Team Notes/kickoff.md': '# Kickoff\n\nKickoff notes.\n',
    '.hidden/secret.md': '# Secret\n\nHidden.\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

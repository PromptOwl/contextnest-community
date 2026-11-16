/**
 * Import Folder Fixtures — the folders, zips and files the Import Folder suite
 * picks in the dialog.
 *
 * Built at run time inside the test's own output folder (tests/test-results,
 * gitignored), so nothing is committed and every run starts clean. The folder
 * or zip name becomes the nest name, so callers pass an AUTO_ name.
 */

import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

/** Write `files` ({ "rel/path": content }) under `root`. */
function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * A folder of three documents plus files that are read but aren't documents
 * (CONTEXT.md, README.md, data.json): "3 documents · 6 files scanned".
 * @returns {string} absolute path of the folder
 */
export function buildDocsFolder(baseDir, name) {
  const root = path.join(baseDir, name);
  writeTree(root, {
    'notes.md': '---\ntitle: Team Notes\ntags: [alpha, beta]\n---\n\n# Team Notes\n\nNotes body.\n',
    'guides/welcome.md': '# Welcome Guide\n\nHello.\n',
    'guides/setup.md': 'Plain setup text with no heading.\n',
    'CONTEXT.md': 'Imported instructions.\n',
    'README.md': '# Readme\n',
    'data.json': '{"a":1}\n',
  });
  return root;
}

/**
 * One document plus content the import skips: an image, a hidden folder,
 * node_modules and _suggestions. "1 document · 1 file scanned".
 * @returns {string} absolute path of the folder
 */
export function buildSkippedContentFolder(baseDir, name) {
  const root = path.join(baseDir, name);
  writeTree(root, {
    'doc.md': '# Kept Doc\n\nThe only document.\n',
    'logo.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    '.git/config': '[core]\n',
    'node_modules/pkg/readme.md': '# Skipped\n',
    '_suggestions/s.md': '# Skipped\n',
  });
  return root;
}

/** A single markdown document. @returns {string} absolute file path */
export function buildSingleMarkdown(baseDir, fileName = 'single.md') {
  const file = path.join(baseDir, fileName);
  writeTree(baseDir, { [fileName]: '# Single Doc\n\nOne file.\n' });
  return file;
}

/**
 * A whole-nest markdown export: two documents in one file, each starting
 * with its own frontmatter. @returns {string} absolute file path
 */
export function buildMarkdownExport(baseDir, fileName = 'export.md') {
  const file = path.join(baseDir, fileName);
  writeTree(baseDir, {
    [fileName]:
      '---\nid: first-doc\ntitle: First Doc\n---\n\n# First Doc\n\nOne.\n\n---\n\n' +
      '---\nid: second-doc\ntitle: Second Doc\n---\n\n# Second Doc\n\nTwo.\n',
  });
  return file;
}

/**
 * A nest .zip named `<name>.zip`. `entries` maps zip-internal paths to text.
 * @returns {Promise<string>} absolute file path
 */
export async function buildZip(baseDir, name, entries) {
  const zip = new JSZip();
  for (const [entry, content] of Object.entries(entries)) zip.file(entry, content);
  const file = path.join(baseDir, `${name}.zip`);
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

/** Two in-memory files for the chooser: a small document and one over 8 MB. */
export function smallAndOversized() {
  return [
    { name: 'small.md', mimeType: 'text/markdown', buffer: Buffer.from('# Small\n\nKept.\n') },
    { name: 'huge.md', mimeType: 'text/markdown', buffer: Buffer.alloc(9 * 1024 * 1024, 'a') },
  ];
}

/**
 * Write a public docs site to a folder, for any static host (CU-wdqcq05jhm).
 *
 *   npm run site:export -- <nestId> <server-origin> <out-dir>
 *   npm run site:export -- ad8fe978-… https://nest.promptowl.ai ./site
 *
 * Runs against this server's own data (same env as the server: DATA_DIR,
 * DATABASE_URL…). The nest must be public with Reader Mode on, and only its
 * approved content is written. Canonicals, the sitemap and llms.txt use the
 * site's configured home — its verified domain or `public_url` setting, set
 * that to where the files will be hosted — else <server-origin>/d/<key>.
 * <server-origin> is also where media and the MCP endpoint are linked.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { initDb } from "../src/db/client.js";
import { buildSiteFiles } from "../src/site/build.js";

const [nestId, base, outDir] = process.argv.slice(2);
if (!nestId || !base || !outDir) {
  console.error("usage: npm run site:export -- <nestId> <server-origin> <out-dir>");
  process.exit(2);
}

await initDb();
const files = await buildSiteFiles(nestId, base);
const root = resolve(outDir);
for (const [path, body] of Object.entries(files)) {
  const target = resolve(root, path);
  // Built paths are validated site paths, but never write outside out-dir.
  if (!target.startsWith(root + sep)) throw new Error(`Refusing to write outside ${root}: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}
console.log(`Wrote ${Object.keys(files).length} files to ${root}`);

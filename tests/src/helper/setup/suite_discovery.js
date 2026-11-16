// @ts-check

/**
 * Finds the e2e suites by reading tests/features, so adding a suite never
 * edits a shared list in playwright.config.js.
 *
 * Rules
 * -----
 * - Every folder directly under tests/features is a suite, named after the
 *   folder. Every `*.spec.js` inside it (at any depth) is one entry in the
 *   run chain.
 * - A suite runs serial, independent and enabled, and gets a shortcut project
 *   (`npx playwright test --project=<folder>`). A suite that differs says so
 *   in an optional `suite.json` in its own folder:
 *
 *     { "mode": "parallel" }        tests in the file run at the same time
 *     { "independent": false }      wait for the previous suite in the chain
 *     { "enabled": false }          leave the suite out of the full run
 *     { "standalone": false }       no shortcut project
 *     { "baseURL": "https://…" }    run against another server
 *
 * - Folders in `ignore` are not suites. The config ignores `global-cleanup`,
 *   which holds the orphan sweep and the teardown it wires up by hand.
 *
 * Order
 * -----
 * Project names are `test-1`, `test-2`, … in run order. The suites that
 * existed when discovery replaced the hand-written list keep their place
 * (ESTABLISHED_ORDER) so their names don't change. Do not add to that list:
 * a new suite sorts after them, by folder name and then by file name.
 */

import fs from 'fs';
import path from 'path';

/** Suites that predate discovery, in their original run order. Frozen. */
export const ESTABLISHED_ORDER = Object.freeze([
  'auth',
  'dashboard',
  'my-work',
  'my-drafts',
  'teams',
  'api-keys',
  'teammates',
  'server-settings',
  'activity-trace',
  'message-log',
  'how-it-works',
  'account',
  'sidebar-rail',
  'access-requests',
  'metacognition',
  'annotations',
  'import-folder',
  'archive',
  'new-document',
  'new-folder',
  'nest-import',
  'nest-overview',
  'nest-documents',
  'review-queue',
  'control-room',
  'collaborators',
  'fields',
  'stewards',
  'nest-settings',
]);

export const SUITE_FILE = 'suite.json';

const SUITE_KEYS = ['mode', 'enabled', 'independent', 'standalone', 'baseURL'];
const MODES = ['serial', 'parallel'];

/**
 * Read and check a suite's optional suite.json.
 * @param {string} suiteDir absolute path of the suite folder
 * @returns {{mode?: string, enabled?: boolean, independent?: boolean, standalone?: boolean, baseURL?: string}}
 */
export function readSuiteSettings(suiteDir) {
  const file = path.join(suiteDir, SUITE_FILE);
  if (!fs.existsSync(file)) return {};

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${file} must hold a JSON object`);
  }
  for (const key of Object.keys(settings)) {
    if (!SUITE_KEYS.includes(key)) {
      throw new Error(`${file} sets "${key}", which is not a suite setting (${SUITE_KEYS.join(', ')})`);
    }
  }
  if ('mode' in settings && !MODES.includes(settings.mode)) {
    throw new Error(`${file}: "mode" must be "serial" or "parallel"`);
  }
  for (const key of ['enabled', 'independent', 'standalone']) {
    if (key in settings && typeof settings[key] !== 'boolean') {
      throw new Error(`${file}: "${key}" must be true or false`);
    }
  }
  if ('baseURL' in settings && (typeof settings.baseURL !== 'string' || !/^https?:\/\/\S+$/.test(settings.baseURL))) {
    throw new Error(`${file}: "baseURL" must be an http(s) URL`);
  }
  return settings;
}

/**
 * Spec files under a suite folder, as sorted paths relative to it.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function specFiles(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...specFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.spec.js')) {
      found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Discover the suites under a features folder.
 *
 * @param {string} featuresDir absolute path of tests/features
 * @param {{ignore?: string[], order?: readonly string[]}} [options]
 * @returns {Array<{
 *   name: string,
 *   standalone: boolean,
 *   runs: Array<{file: string, mode: string, enabled: boolean, independent: boolean, baseURL?: string}>,
 * }>} suites in run order; `runs[].file` is relative to featuresDir
 */
export function discoverSuites(featuresDir, options = {}) {
  const ignore = options.ignore ?? [];
  const order = options.order ?? ESTABLISHED_ORDER;

  const names = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignore.includes(entry.name))
    .map((entry) => entry.name);

  const rank = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));

  const suites = [];
  for (const name of names) {
    const suiteDir = path.join(featuresDir, name);
    const settings = readSuiteSettings(suiteDir);
    const files = specFiles(suiteDir);
    if (files.length === 0) continue; // a folder with no spec is not a suite

    suites.push({
      name,
      standalone: settings.standalone ?? true,
      runs: files.map((file) => ({
        file: `${name}/${file}`,
        mode: settings.mode ?? 'serial',
        enabled: settings.enabled ?? true,
        independent: settings.independent ?? true,
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      })),
    });
  }
  return suites;
}

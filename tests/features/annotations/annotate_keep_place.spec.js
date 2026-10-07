/**
 * Annotations — keep your place, see the highlights (CN-ANNO-001 … CN-ANNO-004)
 *
 * Pages under test: ArtifactViewer (Preview ⇄ Annotate) and DocumentEditor
 * (rich editor ⇄ Markdown source ⇄ Comment mode). CU-wdqcq040et.
 *
 * Conventions
 * -----------
 * - One seeded nest per run (AUTO_ name, registered for teardown) holding a
 *   long HTML artifact and a long markdown doc, each with one anchored
 *   comment. Arranged over REST; the UI is only driven for the toggles.
 * - "Keeps place" is asserted by what text sits at the top of the visible
 *   area after a switch, not by pixel offsets alone.
 * - Mode toggles are clicked through the DOM (`el.click()`): Playwright's own
 *   click scrolls a sticky toolbar button into view first, which would move
 *   the page the test is measuring.
 * - CI runs this suite against the deployed server. Until a server serves
 *   the viewer bridge (`/hosted?embed=1`), the suite skips rather than fail;
 *   CN_EXPECT_BRIDGE=1 turns that skip into a failure.
 * - Serial: the cases share the seeded nest.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;

/** Settle time for debounced place reports and late-mounting surfaces. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sections = Array.from(
  { length: 60 },
  (_, i) =>
    `<section><h2>Section ${i + 1}</h2><p>Paragraph ${i + 1} talks about topic number ${i + 1} with plenty of words to wrap across the line.</p><p>Second paragraph of section ${i + 1}, more filler so the page is long.</p></section>`,
).join('');
const ARTIFACT_HTML = `<!doctype html><html><head><style>body{font-family:sans-serif;max-width:700px;margin:auto}</style></head><body><h1>Long deck</h1>${sections}</body></html>`;

const DOC_MD =
  '# Long doc\n\n' +
  Array.from(
    { length: 60 },
    (_, i) =>
      `## Heading ${i + 1}\n\nBody text ${i + 1} has **bold words ${i + 1}** and more words so that it wraps a little, filler filler.\n\nAnother line for item ${i + 1}.`,
  ).join('\n\n');

/** @type {{ nestId: string, artifactId: string, docId: string } | null} */
let seeded = null;
let bridgeDeployed = false;

/** Toggle by DOM click so the page doesn't scroll to reach the button. */
async function domClick(page, selector) {
  await page.locator(selector).first().evaluate((el) => el.click());
}

/** Top of a heading inside the rich editor, in viewport px. */
function headingTop(page, scope, text) {
  return page.evaluate(
    ({ scope, text }) => {
      const h = [...document.querySelectorAll(`${scope} h2`)].find((e) => e.textContent?.trim() === text);
      return h ? Math.round(h.getBoundingClientRect().top) : null;
    },
    { scope, text },
  );
}

test.describe('Annotations keep your place', () => {
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.beforeAll(async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    const nest = await api.createNest(primary_user.commonFunction.generateEntityName('annotate-place'));
    const artifact = await api.expectOk('POST', `/nests/${nest.id}/nodes`, {
      title: 'Long Artifact',
      content: ARTIFACT_HTML,
      type: 'artifact',
    });
    const doc = await api.expectOk('POST', `/nests/${nest.id}/nodes`, { title: 'Long Doc', content: DOC_MD });
    const artifactId = artifact.node.id;
    const docId = doc.node.id;
    await api.expectOk('POST', `/nests/${nest.id}/nodes/${artifactId}/annotations`, {
      body: 'artifact note',
      anchor: { quote: 'Paragraph 40 talks about topic number 40', before: 'Section 40\n', after: '' },
    });
    await api.expectOk('POST', `/nests/${nest.id}/nodes/${docId}/annotations`, {
      body: 'doc note',
      anchor: { quote: 'has bold words 30 and more', before: 'Heading 30\nBody text 30 ', after: '' },
    });
    seeded = { nestId: nest.id, artifactId, docId };

    const hosted = await primary_user.page.request.get(
      `/nests/${nest.id}/nodes/${artifactId.replace(/^nodes\//, '')}/hosted?embed=1`,
    );
    bridgeDeployed = (await hosted.text()).includes('data-cn-bridge');
  });

  test.beforeEach(() => {
    // Once the bridge is deployed everywhere, set CN_EXPECT_BRIDGE=1 so a
    // server that stops serving it fails here instead of skipping quietly.
    if (process.env.CN_EXPECT_BRIDGE === '1') {
      expect(bridgeDeployed, '/hosted?embed=1 no longer serves the viewer bridge').toBe(true);
    }
    test.skip(!bridgeDeployed, 'The server under test does not serve the viewer bridge yet (pre-CU-wdqcq040et).');
  });

  test.describe('HTML artifact', () => {
    test.describe.configure({ mode: 'serial' });

    test('CN-ANNO-001 preview carries the bridge and paints the comment @smoke', async ({ primary_user }) => {
      await primary_user.initialize();
      const page = primary_user.page;
      await page.goto(`/nest/${seeded.nestId}?doc=${encodeURIComponent(seeded.artifactId)}`);
      const frameEl = await page.waitForSelector('[data-testid="artifact-preview-frame"]');
      const frame = await frameEl.contentFrame();
      await expect
        .poll(() => frame.evaluate(() => CSS.highlights.get('cn-comment')?.size ?? 0), { timeout: 15_000 })
        .toBe(1);
    });

    test('CN-ANNO-002 Preview → Annotate lands on the same passage, with the comment highlighted', async ({ primary_user }) => {
      await primary_user.initialize();
      const page = primary_user.page;
      await page.goto(`/nest/${seeded.nestId}?doc=${encodeURIComponent(seeded.artifactId)}`);
      const frame = await (await page.waitForSelector('[data-testid="artifact-preview-frame"]')).contentFrame();
      await expect.poll(() => frame.evaluate(() => CSS.highlights.get('cn-comment')?.size ?? 0)).toBe(1);
      await frame.evaluate(() => document.querySelectorAll('h2')[29].scrollIntoView({ block: 'start' }));
      await pause(600); // bridge reports place 200ms after scrolling stops
      await page.getByRole('button', { name: /Annotate/ }).evaluate((b) => b.click());
      await page.waitForSelector('pre');
      await pause(800);
      const atTop = await page.evaluate(() => {
        // First y where the text pane itself is what's on screen (below the
        // sticky header and top bar, whatever their height at this viewport).
        const pre = document.querySelector('pre');
        const x = pre.getBoundingClientRect().left + 40;
        let y = 0;
        while (y < innerHeight && !pre.contains(document.elementFromPoint(x, y))) y += 2;
        const r = document.caretRangeFromPoint(x, y + 4);
        return r ? pre.textContent.slice(r.startOffset, r.startOffset + 60) : '';
      });
      expect(atTop).toMatch(/\b30\b/);
      expect(await page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(1);

      // ── and back: scroll the text to Section 50, return to Preview ──
      await page.evaluate(() => {
        const pre = document.querySelector('pre');
        const i = pre.textContent.indexOf('Section 50');
        const r = document.createRange();
        r.setStart(pre.firstChild, i);
        r.setEnd(pre.firstChild, i + 10);
        window.scrollBy(0, r.getBoundingClientRect().top - 140);
      });
      await pause(600);
      const loadsBefore = await page.evaluate(
        () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/hosted')).length,
      );
      await page.getByRole('button', { name: /Preview/ }).evaluate((b) => b.click());
      await pause(900);
      const firstVisible = await frame.evaluate(
        () => [...document.querySelectorAll('h2,p')].find((e) => e.getBoundingClientRect().bottom > 0)?.textContent ?? '',
      );
      expect(firstVisible).toMatch(/\b(49|50)\b/);
      const loadsAfter = await page.evaluate(
        () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/hosted')).length,
      );
      expect(loadsAfter, 'toggling must not reload the preview').toBe(loadsBefore);
    });
  });

  test.describe('Markdown document', () => {
    test.describe.configure({ mode: 'serial' });

    test('CN-ANNO-003 the rich editor paints the comment', async ({ primary_user }) => {
      await primary_user.initialize();
      const page = primary_user.page;
      await page.goto(`/nest/${seeded.nestId}?doc=${encodeURIComponent(seeded.docId)}`);
      await page.waitForSelector('.ProseMirror');
      await expect.poll(() => page.evaluate(() => CSS.highlights.get('comment-anchor')?.size ?? 0)).toBe(1);
    });

    test('CN-ANNO-004 editor ⇄ Markdown source ⇄ Comment mode keep the passage on screen', async ({ primary_user }) => {
      await primary_user.initialize();
      const page = primary_user.page;
      await page.goto(`/nest/${seeded.nestId}?doc=${encodeURIComponent(seeded.docId)}`);
      await page.waitForSelector('.ProseMirror');
      await pause(1000);
      await page.click('.ProseMirror p'); // activates the page → editor toolbar shows
      await page.evaluate(() => {
        const h = [...document.querySelectorAll('.ProseMirror h2')].find((e) => e.textContent === 'Heading 40');
        window.scrollBy(0, h.getBoundingClientRect().top - 200);
      });
      await pause(500);

      // Editor → Markdown source: the raw text is there, highlighted, at the same height.
      await domClick(page, '[data-testid="document-editor-markdown-toggle"]');
      await page.waitForSelector('[data-testid="raw-markdown-highlights"]');
      await pause(500);
      const rawTop = await page.evaluate(() => {
        const m = document.querySelector('[data-testid="raw-markdown-highlights"]');
        const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.data.indexOf('## Heading 40');
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 5);
          return Math.round(r.getBoundingClientRect().top);
        }
        return null;
      });
      expect(Math.abs(rawTop - 200)).toBeLessThan(120);
      await expect(page.locator('[data-testid="raw-markdown-highlights"] mark[data-thread-id]')).toHaveCount(1);

      // Markdown source → editor.
      await domClick(page, '[data-testid="document-editor-rich-toggle"]');
      await page.waitForSelector('.ProseMirror');
      await pause(600);
      expect(Math.abs((await headingTop(page, '.ProseMirror', 'Heading 40')) - 200)).toBeLessThan(120);

      // Editor → Comment mode: the read view scrolls in its own box; the
      // heading should open at the top of it.
      await domClick(page, '[data-testid="document-editor-comments-toggle"]');
      await pause(300);
      await domClick(page, '[data-testid="annotations-comment-mode"]');
      await page.waitForSelector('[data-testid="document-view-surface"]');
      await pause(600);
      const view = await page.evaluate(() => {
        const box = document.querySelector('[data-testid="document-view-surface"]').getBoundingClientRect();
        const h = [...document.querySelectorAll('[data-testid="document-view-surface"] h2')].find((e) =>
          e.textContent?.includes('Heading 40'),
        );
        return { heading: Math.round(h.getBoundingClientRect().top), boxTop: Math.round(box.top) };
      });
      expect(view.heading).toBeGreaterThanOrEqual(view.boxTop - 40);
      expect(view.heading).toBeLessThan(view.boxTop + 200);

      // Comment mode → editor.
      await domClick(page, '[data-testid="annotations-comment-mode"]');
      await page.waitForSelector('.ProseMirror');
      await pause(600);
      expect(Math.abs((await headingTop(page, '.ProseMirror', 'Heading 40')) - 200)).toBeLessThan(150);
    });
  });
});

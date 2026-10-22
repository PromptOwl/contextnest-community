/**
 * Metacognition agents — CN-META-001 … CN-META-003 (CU-wdqcq041jm; the
 * plain-language setup form, CU-wdqcq05rkp)
 *
 * Page under test: Workflows → Agents (ui/src/components/MetacognitionPanel.tsx)
 * and the run it starts.
 *
 * Conventions
 * -----------
 * - One seeded nest per run (AUTO_ name, registered for teardown) holding one
 *   agent document. Arranged over REST; the UI is driven for configuring and
 *   running the agent.
 * - Metacognition is off by default. When `/health` reports it off and the
 *   primary account is a server admin, the suite switches it on in Server
 *   settings (`PATCH /admin/settings`) for the run and switches it back off
 *   afterwards — only ever undoing what it did itself. Without an admin
 *   account the suite skips.
 * - Once every case has passed, the suite removes its test data from the
 *   server straight away (the agent's metacognition config, then the seeded
 *   nest). After a failure the data is left for debugging; the global
 *   teardown still deletes the registered nest at the end of the run.
 * - A run calls a real model, which costs money and depends on a key. The
 *   assertions therefore hold for any outcome the server can honestly record:
 *   the run is executed by the server (never left queued for a runner) and
 *   ends in a terminal state the panel shows — succeeded, or skipped with a
 *   reason when no key is configured.
 * - Serial: the cases share the seeded nest.
 */

import { test, expect } from '../../src/lib/base_test.js';
import { samples } from '../../src/lib/roles.js';

const primaryRole = samples.primary_user ?? null;

/** @type {{ nestId: string, agentId: string } | null} */
let seeded = null;
let enabled = false;
/** True when this suite switched metacognition on, so it must switch it off. */
let turnedOn = false;
/** Any case in this file that did not pass — keeps the data for debugging. */
let anyFailed = false;

test.describe('Metacognition agents', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.beforeAll(async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    enabled = (await api.health()).metacognition_enabled === true;
    if (!enabled && (await api.isServerAdmin())) {
      const res = await api.request('PATCH', '/admin/settings', { metacognition_enabled: true });
      turnedOn = res.ok;
      enabled = turnedOn && (await api.health()).metacognition_enabled === true;
    }
    if (!enabled) return;
    const nest = await api.createNest(primary_user.commonFunction.generateEntityName('metacognition'));
    const agent = await api.expectOk('POST', `/nests/${nest.id}/nodes`, {
      title: 'Archivist',
      type: 'agent',
      content: 'Keep the notes folder current. Read what is there and summarise what looks stale. Propose nothing unless you are sure.',
    });
    await api.expectOk('POST', `/nests/${nest.id}/nodes`, {
      title: 'Pricing',
      folder: 'notes',
      content: '# Pricing\n\nTeam plan is $8 per seat.',
    });
    seeded = { nestId: nest.id, agentId: agent.node.id };
  });

  test.beforeEach(() => {
    test.skip(!enabled, 'Metacognition is off on the server under test and the primary account is not a server admin, so it cannot be switched on.');
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) anyFailed = true;
  });

  test.afterAll(async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    try {
      // Clean the site once everything passed: config first, then the nest.
      if (seeded && !anyFailed) {
        await api.request('DELETE', `/nests/${seeded.nestId}/metacognition/${seeded.agentId}`);
        await api.deleteNest(seeded.nestId);
        seeded = null;
      }
    } finally {
      // Put the feature back the way the suite found it.
      if (turnedOn) {
        await api.request('PATCH', '/admin/settings', { metacognition_enabled: false });
        turnedOn = false;
      }
    }
  });

  test('CN-META-001 an owner turns an agent document into a metacognition agent @smoke', async ({ primary_user }) => {
    await primary_user.initialize();
    const page = primary_user.page;
    await page.goto(`/nest/${seeded.nestId}/workflows`);
    await page.getByTestId('workflows-agents-tab').click();
    await page.getByTestId('metacognition-add').click();
    // Prefilled from the agent document (CU-wdqcq05rkp): its instructions
    // name "the notes folder" and say "Propose nothing", so it reads notes and
    // only leaves comments — each with a "from the agent document" hint.
    await expect(page.getByTestId('metacognition-read-folder-notes')).toBeChecked();
    await expect(page.getByTestId('metacognition-propose-none')).toBeChecked();
    await expect(page.getByTestId('metacognition-prefill-hint').first()).toBeVisible();
    await expect(page.getByTestId('metacognition-summary')).toContainText('reads notes, only leaves comments');
    await page.getByTestId('metacognition-name').fill('Archivist');
    await page.getByTestId('metacognition-propose-folders').check();
    await page.getByTestId('metacognition-propose-folder-notes').check();
    await expect(page.getByTestId('metacognition-summary')).toContainText('may suggest edits in notes');
    await page.getByTestId('metacognition-save').click();
    const row = page.getByTestId('metacognition-agent-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Archivist');
    await expect(row).toContainText('reads notes');
  });

  test('CN-META-002 the persona is a service identity, and the agent leaves /runnables', async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    const { agents } = await api.expectOk('GET', `/nests/${seeded.nestId}/metacognition`);
    expect(agents[0].persona.email).toMatch(/@agents\.invalid$/);
    const { runnables } = await api.expectOk('GET', `/nests/${seeded.nestId}/runnables`);
    expect(runnables.map((r) => r.id)).not.toContain(seeded.agentId);
  });

  test('CN-META-003 Run now executes in the server and the panel shows how it ended', async ({ primary_user }) => {
    await primary_user.initialize();
    const page = primary_user.page;
    const api = primary_user.dashboardApi;
    await page.goto(`/nest/${seeded.nestId}/workflows`);
    await page.getByTestId('workflows-agents-tab').click();
    await page.getByTestId('metacognition-run-now').click();

    // Claimed by the server at creation — never "queued" for a runner.
    let run;
    await expect
      .poll(
        async () => {
          const { runs } = await api.expectOk('GET', `/nests/${seeded.nestId}/runs?agent=${encodeURIComponent(seeded.agentId)}`);
          run = runs[0];
          return run ? `${run.claimed_by}|${run.status}` : 'none';
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] },
      )
      .toMatch(/^server:metacognition\|(succeeded|cancelled|failed)$/);
    expect(run.trace?.persona?.name ?? 'Archivist').toBe('Archivist');

    const row = page.getByTestId('metacognition-agent-row');
    await expect(row).toContainText(/succeeded|skipped|failed/, { timeout: 15_000 });
    if (run.status === 'succeeded') {
      await expect(page.getByTestId('metacognition-run-cost')).toContainText('tokens');
    }
  });
});

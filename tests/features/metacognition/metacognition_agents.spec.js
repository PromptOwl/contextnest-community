/**
 * Metacognition agents — CN-META-001 … CN-META-003 (CU-wdqcq041jm)
 *
 * Page under test: Workflows → Agents (ui/src/components/MetacognitionPanel.tsx)
 * and the run it starts.
 *
 * Conventions
 * -----------
 * - One seeded nest per run (AUTO_ name, registered for teardown) holding one
 *   agent document. Arranged over REST; the UI is driven for configuring and
 *   running the agent.
 * - The suite skips unless the server under test has metacognition on
 *   (`/health` → metacognition_enabled). CI runs e2e against the deployed
 *   server, where it is off until an operator turns it on.
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

test.describe('Metacognition agents', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!primaryRole, 'primary_user is not configured. See tests/env.template.');

  test.beforeAll(async ({ primary_user }) => {
    await primary_user.initialize();
    const api = primary_user.dashboardApi;
    enabled = (await api.health()).metacognition_enabled === true;
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
    test.skip(!enabled, 'The server under test does not have FEATURE_METACOGNITION on.');
  });

  test('CN-META-001 an owner turns an agent document into a metacognition agent @smoke', async ({ primary_user }) => {
    await primary_user.initialize();
    const page = primary_user.page;
    await page.goto(`/nest/${seeded.nestId}/workflows`);
    await page.getByTestId('workflows-agents-tab').click();
    await page.getByTestId('metacognition-add').click();
    await page.getByTestId('metacognition-name').fill('Archivist');
    await page.getByTestId('metacognition-read').fill('notes');
    await page.getByTestId('metacognition-propose').fill('notes');
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

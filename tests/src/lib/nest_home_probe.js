/**
 * Does the server under test ship po-1213 (Overview merged into Documents)?
 *
 * The nest-dev e2e run drives the deployed server, not the PR build, so the
 * cases written against the Documents home skip until it arrives there
 * (`requireNestHome`). The PR-build run sets CN_EXPECT_NEST_HOME=1, which
 * turns that skip into a failure. The signal is the one po-1213 adds to the API:
 * a node list row carries `last_edit`. One probe per worker, cached; the probe
 * nest is created through `api`, so its teardown deletes it with the rest.
 */
let cached;

export async function nestHomeShipped(api, commonFunction) {
  if (cached !== undefined) return cached;
  const probe = await api.createNest(commonFunction.generateEntityName('nesthome-probe'), 'po-1213 probe (safe to delete)');
  // Plain REST through expectOk, which every nest API helper class has.
  await api.expectOk('POST', `/nests/${probe.id}/nodes`, { title: 'Probe', content: '# Probe\n' });
  const data = await api.expectOk('GET', `/nests/${probe.id}/nodes`);
  cached = (data.nodes ?? []).some((r) => !!r.last_edit);
  return cached;
}

/**
 * For a case written against the Documents home: skip it while the server
 * under test still has the Overview tab (nest-dev before po-1213 deploys),
 * and fail instead of skipping when CN_EXPECT_NEST_HOME=1 (the PR build).
 */
export async function requireNestHome(test, expect, api, commonFunction) {
  const shipped = await nestHomeShipped(api, commonFunction);
  if (process.env.CN_EXPECT_NEST_HOME === '1') {
    expect(shipped, 'the server under test does not ship po-1213 (no last_edit on list rows)').toBe(true);
  }
  test.skip(!shipped, 'The server under test still has the Overview tab (po-1213 is not deployed there).');
}

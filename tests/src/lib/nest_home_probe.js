/**
 * Does the server under test ship po-1213 (Overview merged into Documents)?
 *
 * CI runs e2e against the deployed server, not the PR build, so suites that
 * describe the old Overview tab skip once it is gone, and the Documents home
 * suite skips until it arrives. The signal is the one po-1213 adds to the API:
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

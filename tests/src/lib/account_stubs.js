/**
 * Account Stubs — a guard against real account writes
 *
 * The Account page changes the signed-in user's own account: Save writes the
 * name (`PATCH /auth/profile`) and Change password writes the password and
 * signs out every session (`POST /auth/password`). On the shared dev server
 * those are the suite's own test accounts, whose saved sign-ins the other
 * suites rely on. The Account cases never mean to write, so every case
 * installs this guard: both requests are refused at the network boundary and
 * recorded, and the test checks that none was sent.
 */

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

/**
 * Block (and record) any attempt to change the name or the password.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ writes: {method: string, path: string}[] }>}
 */
export async function guardAccountWrites(page) {
  const writes = [];
  await page.route(
    (url) => ['/auth/profile', '/auth/password'].includes(pathOf(url)),
    async (route, request) => {
      if (request.method() === 'GET') return route.fallback();
      writes.push({ method: request.method(), path: pathOf(request.url()) });
      try {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Blocked by the e2e account guard' }) });
      } catch {
        // Aborted by a navigation — nothing to answer.
      }
    }
  );
  return { writes };
}

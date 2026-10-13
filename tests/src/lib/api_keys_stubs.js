/**
 * API Keys Stubs — forced list states
 *
 * Everything the API keys suite changes is a real key on the account
 * (api_keys_api.js). Two states cannot be arranged from a real account:
 *
 *   - the "Loading your keys…" state (the read resolves too fast to observe);
 *   - "No keys yet" on an account that already holds keys.
 *
 * Those are intercepted at the network boundary: the real UI, against the
 * real response shape of `GET /auth/keys` — only the rows are ours.
 */

/** Matches the page's read of the key list. */
function onKeysList(url, request) {
  try {
    return new URL(url).pathname === '/auth/keys' && request.method() === 'GET';
  } catch {
    return false;
  }
}

/** Answer `GET /auth/keys` with `keys`. */
export async function stubKeys(page, keys) {
  await page.route(
    (url) => new URL(url).pathname === '/auth/keys',
    async (route, request) => {
      if (!onKeysList(request.url(), request)) return route.fallback();
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys }) });
      } catch {
        /* aborted by a navigation */
      }
    }
  );
}

/**
 * Hold `GET /auth/keys` until the returned `release()` is called, then answer
 * with `keys`.
 */
export async function holdKeys(page, keys = []) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => new URL(url).pathname === '/auth/keys',
    async (route, request) => {
      if (!onKeysList(request.url(), request)) return route.fallback();
      await gate;
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys }) });
      } catch {
        /* aborted */
      }
    }
  );
  return () => release();
}

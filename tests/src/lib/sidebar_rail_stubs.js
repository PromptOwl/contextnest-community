/**
 * Sidebar Rail Stubs — server capabilities the rail reads, set per test
 *
 * Two rail rows follow server-wide switches the UI reads from `GET /health`:
 * Connected apps (`mcp_oauth_enabled`) and Stream (`experimental.doc_stream`).
 * Flipping those on the shared dev server would change them for everybody,
 * so this stub serves the real `/health` with only those fields overridden,
 * in this browser alone. Nothing is written to the server.
 */

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

/**
 * Serve `GET /health` from the real server with the given fields overridden.
 * @param {import('@playwright/test').Page} page
 * @param {{ mcpOauthEnabled?: boolean, docStream?: boolean }} overrides
 */
export async function stubHealth(page, { mcpOauthEnabled, docStream } = {}) {
  await page.route(
    (url) => pathOf(url) === '/health',
    async (route, request) => {
      if (request.method() !== 'GET') return route.fallback();
      try {
        const res = await route.fetch();
        const body = await res.json();
        if (mcpOauthEnabled !== undefined) body.mcp_oauth_enabled = mcpOauthEnabled;
        if (docStream !== undefined) body.experimental = { ...(body.experimental ?? {}), doc_stream: docStream };
        await route.fulfill({ response: res, json: body });
      } catch {
        // Aborted by a navigation — nothing to answer.
      }
    }
  );
}

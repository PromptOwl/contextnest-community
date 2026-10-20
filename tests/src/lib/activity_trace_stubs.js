/**
 * Activity Trace Stubs — forced trace states
 *
 * Most of the Activity trace suite reads the real server-wide trace, which on
 * a shared server is long and grows with every request (the suite's own
 * included). A few states can't be arranged from it:
 *
 *   - an empty trace and a failed read (the real trace is never empty, and
 *     doesn't fail on demand);
 *   - a read slow enough to watch the Refresh button while it loads;
 *   - an exact last page (the real total keeps moving), and one row of every
 *     shape — api and mcp, a 4xx status, a missing status / nest / duration,
 *     a caller with client attribution — to check each column's format.
 *
 * Those are served here, at the network boundary: the real page, the real
 * response shape (`{ count, total, limit, offset, events }`), only the data
 * is ours. Each read is recorded with its query, so a test can check what the
 * page asked for.
 */

const isTrace = (url, request) => {
  try {
    return new URL(url).pathname === '/admin/trace' && request.method() === 'GET' && request.resourceType() !== 'document';
  } catch {
    return false;
  }
};

const queryOf = (url) => {
  const q = new URL(url).searchParams;
  return { kind: q.get('kind'), user: q.get('user'), limit: Number(q.get('limit') ?? 25), offset: Number(q.get('offset') ?? 0) };
};

/** A trace row shaped like `GET /admin/trace` returns one. */
export function traceRow(i, overrides = {}) {
  return {
    id: 900000 + i,
    ts: new Date(Date.now() - i * 60_000).toISOString().slice(0, 19).replace('T', ' '),
    kind: 'api',
    method: 'GET',
    path: `/nests/stub-nest/nodes/row-${i}`,
    tool: null,
    nest_id: 'stub-nest',
    user_id: 'stub-user',
    caller: 'stub-caller@example.com',
    status: 200,
    duration_ms: 12,
    ...overrides,
  };
}

/**
 * Serve the trace from `rows` — filtered by kind and user and paged by
 * limit/offset the way the server does.
 * @param {import('@playwright/test').Page} page
 * @param {any[] | {status: number, body: any}} source rows, or a forced response
 * @returns {Promise<{ reads: {kind: string|null, user: string|null, limit: number, offset: number}[] }>}
 */
export async function stubTrace(page, source) {
  const reads = [];
  await page.route(
    (url) => new URL(url).pathname === '/admin/trace',
    async (route, request) => {
      if (!isTrace(request.url(), request)) return route.fallback();
      const q = queryOf(request.url());
      reads.push(q);
      let status = 200;
      let body;
      if (Array.isArray(source)) {
        const matching = source.filter(
          (r) => (!q.kind || r.kind === q.kind) && (!q.user || String(r.caller ?? '').toLowerCase().includes(q.user.toLowerCase()))
        );
        const events = matching.slice(q.offset, q.offset + q.limit);
        body = { count: events.length, total: matching.length, limit: q.limit, offset: q.offset, events };
      } else {
        ({ status = 200, body } = source);
      }
      try {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      } catch {
        // Aborted by a navigation — nothing to answer.
      }
    }
  );
  return { reads };
}

/**
 * Hold every trace read until the returned `release()` is called, then pass
 * it through to the real server. Used to watch the page while it loads.
 */
export async function holdTrace(page) {
  let release;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => new URL(url).pathname === '/admin/trace',
    async (route, request) => {
      if (!isTrace(request.url(), request)) return route.fallback();
      await gate;
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        /* aborted */
      }
    }
  );
  return {
    release: () => release(),
    /** Hold the next read again after a release. */
    rearm: () => {
      gate = new Promise((resolve) => {
        release = resolve;
      });
    },
  };
}

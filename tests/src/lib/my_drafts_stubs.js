/**
 * My Drafts Stubs — forced list states
 *
 * Almost everything on My Drafts is arranged for real through my_drafts_api.js.
 * A few states cannot be:
 *
 *   - the "no unsubmitted drafts" empty state (a shared test account has
 *     drafts of its own);
 *   - more than one page of drafts (the server pages at 25, and seeding 26+
 *     real drafts costs minutes on nest-dev), and a later page that comes back
 *     empty while the total still counts drafts (the race the page falls back
 *     to page 1 for).
 *
 * Those are intercepted at the network boundary: the real UI, against the
 * real response shape of `GET /me/drafts` — only the rows are ours. The
 * responder below honours `limit`, `offset`, `q` and `sort` exactly as the
 * server does (listMyDrafts in src/governance/version-service.ts), so search,
 * sort and paging drive it the way they drive the real endpoint.
 */

/** Matches every read of the list: the page's own and the rail badge's. */
function onMyDrafts(url) {
  try {
    return new URL(url).pathname === '/me/drafts';
  } catch {
    return false;
  }
}

/** The query exactly as the server reads it off a request. */
function listParams(request) {
  const params = new URL(request.url()).searchParams;
  return {
    limit: Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100),
    offset: Math.max(Number(params.get('offset')) || 0, 0),
    q: params.get('q') ?? '',
    sort: params.get('sort') === 'title' ? 'title' : 'updated',
    // Whether the request is the rail badge's one-row count, not the page.
    badge: params.has('limit'),
  };
}

/** A draft row shaped like `GET /me/drafts` returns one. */
export function draftRow(overrides = {}) {
  return {
    nest_id: 'stub-nest-a',
    nest_name: 'Stub Nest A',
    node_id: `nodes/stub-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Stub draft',
    folder: '',
    status: 'draft',
    version: 1,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * `count` draft rows titled "<prefix> 01", "<prefix> 02", … — newest first,
 * so the default "Recently edited" order runs 01, 02, … and a title sort
 * puts them back the same way only because the numbers are padded.
 */
export function draftRows(count, { prefix, nestName = 'Stub Nest A' }) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return draftRow({
      nest_name: nestName,
      node_id: `nodes/stub-draft-${n}`,
      title: `${prefix} ${n}`,
      updated_at: new Date(now - i * 60_000).toISOString(),
    });
  });
}

/**
 * The server's own slicing over a fixed set of rows: search (title, nest name
 * and node id, case-insensitive), sort, then the page.
 * @param {Array<Object>} rows - In "Recently edited" order
 */
export function listResponder(rows) {
  return ({ limit, offset, q, sort }) => {
    const needle = q.trim().toLowerCase();
    let matched = needle
      ? rows.filter((d) =>
        [d.title, d.nest_name, d.node_id].some((s) => s.toLowerCase().includes(needle))
      )
      : [...rows];
    if (sort === 'title') matched = matched.sort((a, b) => a.title.localeCompare(b.title));
    return {
      drafts: matched.slice(offset, offset + limit),
      pagination: {
        total: matched.length,
        limit,
        offset,
        has_more: offset + limit < matched.length,
      },
    };
  };
}

/**
 * Serve the list from `respond`, called with the request's
 * `{limit, offset, q, sort}`. Returns a setter to swap the responder without
 * re-routing, and the log of every page read (the badge's are left out) so a
 * test can check what the page asked the server for.
 *
 * @param {import('@playwright/test').Page} page
 * @param {(params: {limit: number, offset: number, q: string, sort: string}) => Object} respond
 * @returns {Promise<{setResponder: (next: Function) => void, calls: Array<Object>}>}
 */
export async function stubMyDrafts(page, respond) {
  let current = respond;
  const calls = [];
  await page.route(onMyDrafts, async (route, request) => {
    const params = listParams(request);
    if (!params.badge) calls.push(params);
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(current(params)),
      });
    } catch {
      // The request was aborted by a navigation or reload — nothing to answer.
    }
  });
  return {
    setResponder: (next) => {
      current = next;
    },
    calls,
  };
}

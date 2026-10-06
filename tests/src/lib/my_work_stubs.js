/**
 * My Work Stubs — forced inbox states
 *
 * Almost everything on My Work is arranged for real through my_work_api.js.
 * A few states cannot be:
 *
 *   - the loading spinner (the read resolves too fast to observe) and the
 *     "all caught up" empty state (a shared test account has work waiting);
 *   - more than 8 unread notifications, and "Mark all read" — which, for real,
 *     would clear every unread notification the account holds, including the
 *     pending invites the dashboard suite is counting at the same moment;
 *   - 51 pending reviews in a single nest (the bulk cap) and more than one
 *     page of them (pagination).
 *
 * Those are intercepted at the network boundary: the real UI, against the
 * real response shape of `GET /me/work` — only the rows are ours.
 */

/** Matches every read of the inbox: the page's own and the rail badge's. */
function onMyWork(url) {
  try {
    return new URL(url).pathname === '/me/work';
  } catch {
    return false;
  }
}

function onNotificationsRead(url) {
  try {
    return new URL(url).pathname === '/me/notifications/read';
  } catch {
    return false;
  }
}

/** `limit` / `offset` exactly as the server reads them off a request. */
function pageParams(request) {
  const params = new URL(request.url()).searchParams;
  return {
    limit: Number(params.get('limit')) || 50,
    offset: Number(params.get('offset')) || 0,
  };
}

/** A pending-review row shaped like `GET /me/work` returns one. */
export function reviewItem(overrides = {}) {
  return {
    type: 'review',
    nest_id: 'stub-nest-a',
    nest_name: 'Stub Nest A',
    node_id: `nodes/stub-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Stub review',
    requested_by: 'author@example.com',
    requested_at: new Date().toISOString(),
    priority: 'normal',
    ...overrides,
  };
}

/** `count` review rows in one nest, titled "<prefix> 01", "<prefix> 02", … */
export function reviewItems(count, { nestId, nestName, prefix }) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return reviewItem({
      nest_id: nestId,
      nest_name: nestName,
      node_id: `nodes/${nestId}-doc-${n}`,
      title: `${prefix} ${n}`,
    });
  });
}

/** An unread notification shaped like `GET /me/work` returns one. */
export function notificationRow(overrides = {}) {
  return {
    id: `stub-notification-${Math.random().toString(36).slice(2, 10)}`,
    nest_id: 'stub-nest-a',
    kind: 'review_requested',
    subject_id: null,
    message: 'Stub notification',
    created_at: new Date().toISOString(),
    read_at: null,
    node_id: null,
    nest_name: 'Stub Nest A',
    ...overrides,
  };
}

/** An inbox body with nothing in it. */
export function emptyWork(overrides = {}) {
  return {
    items: [],
    waiting: [],
    notifications: [],
    pagination: { total: 0, limit: 50, offset: 0, has_more: false },
    ...overrides,
  };
}

/**
 * Serve the inbox from `respond`, called with the request's `{limit, offset}`.
 * Returns a setter so a test can swap the responder without re-routing.
 *
 * @param {import('@playwright/test').Page} page
 * @param {(params: {limit: number, offset: number}) => Object} respond
 * @returns {Promise<(next: (params: {limit: number, offset: number}) => Object) => void>}
 */
export async function stubMyWork(page, respond) {
  let current = respond;
  await page.route(onMyWork, (route, request) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(current(pageParams(request))),
    })
  );
  return (next) => {
    current = next;
  };
}

/**
 * Serve the account's real inbox with its `notifications` replaced — the
 * reviews and requests on the page stay live; only the strip is ours.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<Object>} notifications
 * @returns {Promise<(next: Array<Object>) => void>}
 */
export async function stubNotifications(page, notifications) {
  let current = notifications;
  await page.route(onMyWork, async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => emptyWork());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, notifications: current }),
    });
  });
  return (next) => {
    current = next;
  };
}

/**
 * Hold the inbox read back so the loading state can be observed, then answer
 * it with `body` once released.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} body
 * @returns {Promise<() => void>} Release function
 */
export async function holdMyWork(page, body) {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(onMyWork, async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return release;
}

/**
 * Answer `POST /me/notifications/read` without touching the server, recording
 * what the UI asked for.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Array<Object>>} Live list of the request bodies seen
 */
export async function captureNotificationsRead(page) {
  const seen = [];
  await page.route(onNotificationsRead, async (route, request) => {
    seen.push(request.postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  return seen;
}

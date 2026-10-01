/**
 * Route Stubs — forced dashboard states
 *
 * A handful of dashboard behaviours cannot be arranged from a real account:
 * the cold-load skeletons (the list resolves too fast to observe), the
 * "no nests at all" and "not allowed to create" empty states (a shared test
 * account has nests, and its permissions are the server's), an
 * anonymous-admin nest (an open-mode/legacy artifact), chip overflow at five
 * collaborators (ten placeholder users of residue per run), unsynced folders
 * (files on the server's disk), and every server-failure path.
 *
 * Those are intercepted at the network boundary instead. The assertion is
 * still the real UI against a real response shape — only the response is
 * ours. Everything else in the suite runs against live data.
 *
 * Every helper matches on `pathname` via a predicate rather than a glob: the
 * dashboard calls `/nests` and `/nests?archived=1`, and a glob of `**​/nests`
 * would silently miss the second.
 */

/** Pathname-exact route predicate. */
function onPath(pathname) {
  return (url) => {
    try {
      return new URL(url).pathname === pathname;
    } catch {
      return false;
    }
  };
}

/** Pathname-exact predicate that also requires `?archived=1`. */
function onArchivedList() {
  return (url) => {
    try {
      const u = new URL(url);
      return u.pathname === '/nests' && u.searchParams.get('archived') === '1';
    } catch {
      return false;
    }
  };
}

/** Pathname-exact predicate for the live (non-archived) nest list. */
function onLiveList() {
  return (url) => {
    try {
      const u = new URL(url);
      return u.pathname === '/nests' && u.searchParams.get('archived') !== '1';
    } catch {
      return false;
    }
  };
}

/** A nest row shaped like `GET /nests` returns one. */
export function nestRow(overrides = {}) {
  return {
    id: `stub-${Math.random().toString(36).slice(2, 10)}`,
    user_id: '11111111-1111-1111-1111-111111111111',
    name: 'Stub Nest',
    slug: 'stub-nest',
    description: null,
    visibility: 'private',
    document_count: 0,
    pinned: false,
    is_owner: true,
    permission: 'owner',
    roles: [],
    discovered: false,
    is_imported: false,
    stewardship_enabled: false,
    collaborator_emails: [],
    steward_emails: [],
    owner_email: null,
    created_at: '2026-01-01 10:00:00',
    last_activity: '2026-01-01 10:00:00',
    ...overrides,
  };
}

/** An unsynced-folder row shaped like `GET /nests/unsynced` returns one. */
export function unsyncedRow(overrides = {}) {
  return {
    name: 'stub-folder',
    label: 'Stub Folder',
    mdCount: 3,
    ...overrides,
  };
}

/**
 * Serve a fixed live nest list. Returns a setter so a test can change the
 * list mid-flight (e.g. a sync that adds a nest) without re-routing.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<Object>} nests
 * @returns {Promise<(next: Array<Object>) => void>}
 */
export async function stubNestList(page, nests) {
  let current = nests;
  await page.route(onLiveList(), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nests: current }),
    })
  );
  return (next) => {
    current = next;
  };
}

/** Serve a fixed archived nest list (`GET /nests?archived=1`). */
export async function stubArchivedList(page, nests) {
  await page.route(onArchivedList(), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nests }),
    })
  );
}

/** Serve a fixed unsynced-folder list. */
export async function stubUnsynced(page, folders) {
  let current = folders;
  await page.route(onPath('/nests/unsynced'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders: current }),
    })
  );
  return (next) => {
    current = next;
  };
}

/** Answer the unsynced list with 403, exactly as it does for a non-admin. */
export async function stubUnsyncedForbidden(page) {
  await page.route(onPath('/nests/unsynced'), (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Server admin only' }),
    })
  );
}

/** Serve an empty unread-notification inbox (keeps Pending invites out). */
export async function stubNoNotifications(page) {
  await page.route(onPath('/me/notifications'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ notifications: [] }),
    })
  );
}

/**
 * Report the caller as a non-admin on a server that only lets admins create
 * nests — the UI's `canCreate` then resolves false.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [adminEmail] - Shown in the "ask your admin" empty state
 */
export async function stubNonCreator(page, adminEmail = 'admin@example.com') {
  await page.route(onPath('/auth/admin-status'), async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...body,
        claimed: true,
        admin: { email: adminEmail, name: 'Server Admin' },
        me: { ...(body?.me ?? {}), email: body?.me?.email ?? 'user@example.com', is_admin: false },
      }),
    });
  });
  await page.route(onPath('/health'), async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, nest_creation: 'admins' }),
    });
  });
}

/**
 * Hold a response back so a loading state can be observed, then release it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} pathname
 * @param {Object} body - JSON to answer with once released
 * @returns {Promise<() => void>} Release function
 */
export async function holdRoute(page, pathname, body) {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(onPath(pathname), async (route) => {
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
 * Fail a request with a JSON error body — the shape `api.request` turns into
 * the `Error.message` the UI displays.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} pathname
 * @param {Object} [opts]
 * @param {number} [opts.status=500]
 * @param {string} [opts.error] - Message the UI should surface
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [opts.method] - Only fail this method
 */
export async function failRoute(page, pathname, { status = 500, error = 'Server error', method } = {}) {
  await page.route(onPath(pathname), async (route, request) => {
    if (method && request.method() !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error }),
    });
  });
}

/** Succeed a request with a fixed body, without touching the server. */
export async function okRoute(page, pathname, body = {}, { method } = {}) {
  await page.route(onPath(pathname), async (route, request) => {
    if (method && request.method() !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

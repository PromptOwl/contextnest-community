/**
 * Teams Stubs — forced list states
 *
 * Most of the Teams suite runs against real teams (teams_api.js). A few states
 * cannot be arranged from a real account:
 *
 *   - the loading spinner (the read resolves too fast to observe), the empty
 *     state (a shared test account owns teams), and a failed read;
 *   - a roster longer than five with a mix of registered and invited members
 *     (adding an invited address creates a placeholder account on the server,
 *     which a test should not leave behind);
 *   - the PromptOwl Teams feature switched on or off (a server setting), and
 *     the PromptOwl side of it (a call out to PromptOwl).
 *
 * Those are intercepted at the network boundary: the real UI, against the
 * real response shapes — only the data is ours.
 */

/** Matches the page's own read of the list (`GET /teams`), not the HTML shell. */
function onTeamsList(url, request) {
  try {
    return new URL(url).pathname === '/teams' && request.method() === 'GET' && request.resourceType() !== 'document';
  } catch {
    return false;
  }
}

/** A team member shaped like `GET /teams` returns one. */
export function member(email, { role = 'viewer', registered = true } = {}) {
  return { userId: `stub-user-${email}`, email, role, registered };
}

/** A team shaped like `GET /teams` returns one. */
export function teamRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `stub-team-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Stub team',
    owner_id: 'stub-owner',
    owner_email: 'owner@example.com',
    members: [],
    source: null,
    external_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Answer `GET /teams` from `respond` (an object, or a function of nothing).
 * `{ status, body }` lets a test force a failure.
 * @param {import('@playwright/test').Page} page
 * @param {{status?: number, body: any} | (() => {status?: number, body: any})} respond
 */
export async function stubTeams(page, respond) {
  await page.route(
    (url) => new URL(url).pathname === '/teams',
    async (route, request) => {
      if (!onTeamsList(request.url(), request)) return route.fallback();
      const { status = 200, body } = typeof respond === 'function' ? respond() : respond;
      try {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      } catch {
        // Aborted by a navigation — nothing to answer.
      }
    }
  );
}

/**
 * Hold `GET /teams` until the returned `release()` is called, then answer
 * with `body`.
 */
export async function holdTeams(page, body) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => new URL(url).pathname === '/teams',
    async (route, request) => {
      if (!onTeamsList(request.url(), request)) return route.fallback();
      await gate;
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      } catch {
        /* aborted */
      }
    }
  );
  return () => release();
}

/**
 * Serve the real `/health`, with the PromptOwl Teams flag forced to `enabled`.
 * The SPA reads its feature flags from there before it renders.
 */
export async function stubPromptowlTeamsFlag(page, enabled) {
  await page.route(
    (url) => new URL(url).pathname === '/health',
    async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, promptowl_teams_enabled: enabled } });
      } catch {
        /* aborted */
      }
    }
  );
}

/** Answer the PromptOwl side of the feature (`GET /teams/promptowl`) without calling out. */
export async function stubPromptowlTeams(page, teams = []) {
  await page.route(
    (url) => new URL(url).pathname === '/teams/promptowl',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ teams }) }).catch(() => {})
  );
}

/**
 * Teammates Stubs — a stand-in user directory for the Teammates page
 *
 * The Teammates page acts on real accounts on a shared server: inviting
 * creates an account, Reset password replaces someone's password, Grant and
 * Revoke change who is a server admin, and Remove deletes an account. Run
 * against the shared dev server, those would act on real people (resetting the
 * secondary test account's password would break its own sign-in). A roster
 * with invited users, granted admins and stewards who have no account yet can't
 * be arranged from a real account either without leaving accounts behind.
 *
 * So the directory is served here, at the network boundary: the real UI, the
 * real response shapes, and every write the page sends is answered — and
 * recorded, so a test can check exactly what the page asked the server to do —
 * without reaching the server. Reads update from the writes, the way the
 * server's would, so the page's own refetches show the result.
 */

/** A user row shaped like `GET /auth/teammates` returns one. */
export function teammate(email, overrides = {}) {
  return {
    id: `stub-user-${email.replace(/[^a-z0-9]/gi, '-')}`,
    email,
    name: null,
    is_admin: false,
    is_invited: 0,
    key_count: 0,
    last_active: null,
    ...overrides,
  };
}

/** A super-admin row shaped like `GET /admin/super-admins` returns one. */
export function superAdmin(email, { source = 'granted', self = false } = {}) {
  return {
    email,
    source,
    granted_by: source === 'granted' ? 'stub-admin@example.com' : null,
    granted_at: source === 'granted' ? new Date().toISOString() : null,
    self,
  };
}

/** Server-format UTC timestamp ('YYYY-MM-DD HH:MM:SS') `ms` ago. */
export function serverTimeAgo(ms) {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');
}

const path = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

async function answer(route, status, body) {
  try {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  } catch {
    // Aborted by a navigation — nothing to answer.
  }
}

/**
 * Serve the Teammates directory from `state` and answer the page's writes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ teammates: any[], pending_stewards?: string[], super_admins?: any[] }} state
 *   Mutated as the page writes, so later reads reflect them.
 * @param {{ tempPassword?: string, emailed?: boolean, promptowl?: boolean }} [opts]
 * @returns {Promise<{ calls: {method: string, path: string, body: any}[], state: any }>}
 *   `calls` lists every write the page sent, in order.
 */
export async function stubTeammates(page, state, opts = {}) {
  const calls = [];
  state.pending_stewards = state.pending_stewards ?? [];
  state.super_admins = state.super_admins ?? [];
  const tempPassword = opts.tempPassword ?? 'Stub-Temp-Pass-7Q2x';
  let resets = 0;

  const record = (request) => {
    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    calls.push({ method: request.method(), path: path(request.url()), body });
  };

  // GET /auth/teammates
  await page.route(
    (url) => path(url) === '/auth/teammates',
    async (route, request) => {
      if (request.method() !== 'GET' || request.resourceType() === 'document') return route.fallback();
      await answer(route, 200, { teammates: state.teammates, pending_stewards: state.pending_stewards });
    }
  );

  // GET / POST /admin/super-admins, DELETE /admin/super-admins/:email
  await page.route(
    (url) => path(url) === '/admin/super-admins' || path(url).startsWith('/admin/super-admins/'),
    async (route, request) => {
      if (request.resourceType() === 'document') return route.fallback();
      const p = path(request.url());
      if (request.method() === 'GET' && p === '/admin/super-admins') {
        return answer(route, 200, { super_admins: state.super_admins });
      }
      record(request);
      if (request.method() === 'POST') {
        const email = request.postDataJSON()?.email;
        state.super_admins.push(superAdmin(email));
        const t = state.teammates.find((x) => x.email.toLowerCase() === String(email).toLowerCase());
        if (t) t.is_admin = true;
        return answer(route, 200, { email, source: 'granted', granted_by: 'stub-admin@example.com' });
      }
      if (request.method() === 'DELETE') {
        const email = decodeURIComponent(p.slice('/admin/super-admins/'.length));
        state.super_admins = state.super_admins.filter((a) => a.email.toLowerCase() !== email.toLowerCase());
        const t = state.teammates.find((x) => x.email.toLowerCase() === email.toLowerCase());
        if (t) t.is_admin = false;
        return answer(route, 200, { ok: true, email });
      }
      return route.fallback();
    }
  );

  // POST /auth/invite
  await page.route(
    (url) => path(url) === '/auth/invite',
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      record(request);
      const email = request.postDataJSON()?.email;
      const user = teammate(email, { is_invited: 1 });
      state.teammates.push(user);
      state.pending_stewards = state.pending_stewards.filter((e) => e.toLowerCase() !== String(email).toLowerCase());
      return answer(route, 201, {
        temporary_password: tempPassword,
        user: { id: user.id, email },
        promptowl_sign_in: !!opts.promptowl,
        emailed: !!opts.emailed,
        message: 'Teammate added',
      });
    }
  );

  // POST /auth/admin/reset-password/:userId
  await page.route(
    (url) => path(url).startsWith('/auth/admin/reset-password/'),
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      record(request);
      resets++;
      const id = decodeURIComponent(path(request.url()).split('/').pop());
      const t = state.teammates.find((x) => x.id === id);
      return answer(route, 200, { ok: true, email: t?.email ?? '', temporary_password: `${tempPassword}-${resets}` });
    }
  );

  // DELETE /auth/users/:userId
  await page.route(
    (url) => path(url).startsWith('/auth/users/'),
    async (route, request) => {
      if (request.method() !== 'DELETE') return route.fallback();
      record(request);
      const id = decodeURIComponent(path(request.url()).split('/').pop());
      const t = state.teammates.find((x) => x.id === id);
      state.teammates = state.teammates.filter((x) => x.id !== id);
      return answer(route, 200, { ok: true, email: t?.email ?? '' });
    }
  );

  return { calls, state };
}

/**
 * Answer `POST /nests/:id/collaborators` for `email` without calling the
 * server (sharing a nest with an address that has no account would create a
 * placeholder account). Other collaborator writes pass through.
 * @returns {Promise<{method: string, path: string, body: any}[]>} the shares the page sent
 */
export async function stubShareNest(page, email) {
  const calls = [];
  await page.route(
    (url) => /^\/nests\/[^/]+\/collaborators$/.test(path(url)),
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      const body = request.postDataJSON();
      if (String(body?.email).toLowerCase() !== email.toLowerCase()) return route.fallback();
      calls.push({ method: 'POST', path: path(request.url()), body });
      return answer(route, 201, { collaborator: { id: `stub-collab-${calls.length}`, email, permission: body.permission } });
    }
  );
  return calls;
}

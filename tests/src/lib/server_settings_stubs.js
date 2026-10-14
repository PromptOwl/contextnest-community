/**
 * Server Settings Stubs — saves that never reach the shared server
 *
 * Every option on Server settings is server-wide: saving one on the shared
 * dev server changes it for everybody (sign-in rules, SSO, the model gateway,
 * who may create nests, email and Slack delivery, run retention…), and "Send
 * test" posts to a real Slack or Teams channel. So the page's writes are
 * answered here, at the network boundary, and recorded — a test checks exactly
 * what the page asked the server to change. Reads come from the real server
 * (with optional overrides to put the page in a known state), so the page
 * renders what the server really returns.
 *
 * After a stubbed save the stubbed read reflects it, the way the server's
 * would, so the page's own refresh shows the result. Write-only fields come
 * back the way the server reports them (a masked tail or a "_set" flag).
 */

const pathOf = (url) => {
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

const tail = (s) => String(s).slice(-4);

/** Apply a PATCH body to a settings object the way the server reports it back. */
export function applyPatch(settings, patch) {
  const next = { ...settings };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'anthropic_api_key') next.anthropic_api_key_masked = v === null ? null : `••••${tail(v)}`;
    else if (k === 'oidc_client_secret') next.oidc_client_secret_set = v !== null;
    else if (k === 'mcp_signing_secret') next.mcp_signing_secret_set = v !== null;
    else if (k === 'ses_secret_access_key') next.ses_secret_access_key_set = v !== null;
    else if (k === 'provider_keys') {
      const own = { ...(next.own_providers ?? {}) };
      for (const [p, key] of Object.entries(v ?? {})) {
        if (key === null) delete own[p];
        else own[p] = { masked: tail(key), updatedAt: new Date().toISOString() };
      }
      next.own_providers = own;
    } else next[k] = v;
  }
  return next;
}

/**
 * Serve `GET /admin/settings` from the real server with `overrides` applied,
 * and answer `PATCH /admin/settings` without reaching it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ overrides?: object, onPatch?: (patch: object, settings: object) => ({status: number, body: object} | null) }} [opts]
 *   `onPatch` may return a response to force (e.g. a 400 with fieldErrors); null = accept.
 * @returns {Promise<{ patches: object[], current: () => object|null }>}
 */
export async function stubServerSettings(page, opts = {}) {
  const patches = [];
  let current = null;
  await page.route(
    (url) => pathOf(url) === '/admin/settings',
    async (route, request) => {
      if (request.resourceType() === 'document') return route.fallback();
      if (request.method() === 'GET') {
        if (!current) {
          try {
            const res = await route.fetch();
            current = { ...(await res.json()), ...(opts.overrides ?? {}) };
          } catch {
            return;
          }
        }
        return answer(route, 200, current);
      }
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON() ?? {};
        patches.push(patch);
        const forced = opts.onPatch?.(patch, current);
        if (forced) return answer(route, forced.status, forced.body);
        current = applyPatch(current ?? {}, patch);
        return answer(route, 200, { settings: current });
      }
      return route.fallback();
    }
  );
  return { patches, current: () => current };
}

/**
 * Hold `GET /admin/settings` until the returned `release()` is called, then
 * pass the real response through.
 */
export async function holdServerSettings(page) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => pathOf(url) === '/admin/settings',
    async (route, request) => {
      if (request.method() !== 'GET' || request.resourceType() === 'document') return route.fallback();
      await gate;
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        /* aborted */
      }
    }
  );
  return () => release();
}

/**
 * Answer "Send test" (`POST /admin/settings/test-notification`) without
 * posting to a real channel. Returns the channels the page asked to test.
 */
export async function stubTestNotification(page, { status = 200, error } = {}) {
  const sent = [];
  await page.route(
    (url) => pathOf(url) === '/admin/settings/test-notification',
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      sent.push(request.postDataJSON());
      return answer(route, status, status < 300 ? { ok: true } : { error: error ?? 'Webhook rejected the message' });
    }
  );
  return sent;
}

/** A community site shaped like `GET /admin/community-sites` returns one. */
export function communitySite(name, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `stub-site-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    url: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.com`,
    secret_set: true,
    is_active: true,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/**
 * Serve the community-site list from `sites` and answer its writes (add,
 * edit, enable switch, remove), keeping `sites` up to date so the page's
 * refetch shows the result.
 * @returns {Promise<{ calls: {method: string, path: string, body: any}[], sites: () => any[] }>}
 */
export async function stubCommunitySites(page, sites = []) {
  const calls = [];
  let list = sites.map((s) => ({ ...s }));
  await page.route(
    (url) => pathOf(url) === '/admin/community-sites' || pathOf(url).startsWith('/admin/community-sites/'),
    async (route, request) => {
      if (request.resourceType() === 'document') return route.fallback();
      const p = pathOf(request.url());
      const method = request.method();
      if (method === 'GET') return answer(route, 200, { community_sites: list });
      const body = method === 'DELETE' ? null : request.postDataJSON();
      calls.push({ method, path: p, body });
      if (method === 'POST') {
        const { secret, ...rest } = body ?? {};
        const site = communitySite(rest.name ?? 'Site', { ...rest, secret_set: !!secret });
        list.push(site);
        return answer(route, 201, site);
      }
      const id = decodeURIComponent(p.split('/').pop());
      const site = list.find((s) => s.id === id);
      if (!site) return answer(route, 404, { error: 'Community site not found' });
      if (method === 'PATCH') {
        const { secret, ...rest } = body ?? {};
        Object.assign(site, rest, secret ? { secret_set: true } : {}, { updated_at: new Date().toISOString() });
        return answer(route, 200, site);
      }
      if (method === 'DELETE') {
        list = list.filter((s) => s.id !== id);
        return answer(route, 200, { ok: true, id });
      }
      return route.fallback();
    }
  );
  return { calls, sites: () => list };
}

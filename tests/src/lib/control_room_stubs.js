/**
 * Control Room Stubs — a fake Slack workspace behind the /surfaces routes
 *
 * The setup wizard (po-1186 CR3) talks to Slack through the server: install,
 * credentials, OAuth, the channel list, the guard preview, seeds, bindings.
 * A shared test server has no Slack workspace, and connecting one would post
 * a real notice in real channels, so those calls are answered here, in this
 * browser only, from one stateful fake. The real UI renders real response
 * shapes; nothing is written to the server.
 *
 * Slack's OAuth is stubbed too: "Open Slack to approve" navigates to
 * /surfaces/slack/installs/:id/oauth/start, which this fake answers by marking
 * the install active and redirecting back to the Control room, as the real
 * callback page does.
 *
 * `state.calls` records every write, so a test can assert that nothing was
 * saved before the step that saves it.
 */

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

/** Channels the fake bot is in, with the guard answer for each nest. */
export const FAKE_CHANNELS = [
  { id: 'C_RENEW', name: 'acme-renewal', is_private: true, is_ext_shared: false, num_members: 7 },
  { id: 'C_REVOPS', name: 'revops', is_private: false, is_ext_shared: false, num_members: 18 },
  { id: 'C_LEAD', name: 'leadership', is_private: true, is_ext_shared: false, num_members: 6 },
  { id: 'C_SHARED', name: 'acme-shared', is_private: true, is_ext_shared: true, num_members: 9 },
];

const detail = (over = {}) => ({
  readers_total: 3,
  readers_absent: 0,
  members_total: 7,
  members_not_readers: 0,
  guests: 0,
  externals: 0,
  non_user_principals: [],
  universe: false,
  org_wide: false,
  ext_shared: false,
  server_admins_disclosed: true,
  ...over,
});

/**
 * The guard's answer for a channel. `refuse` names the channels that are
 * refused whatever the nest, unless the nest was created for them in the test.
 */
function previewFor(state, { conversation_id, nest_id, ext_capture_enabled }) {
  const base = { no_seed: !state.seeded.includes(nest_id), seeds: [], conversation_kind: 'private_channel', ext_capture_enabled: !!ext_capture_enabled, disclosure: "This server's administrators can read every nest." };
  const ok = (surface_ok, d) => ({ ...base, would_bind: true, is_ext_shared: false, guard: { capture_ok: true, surface_ok, members_known: true, org_public: false, capture_basis: 'subset', detail: detail(d) } });
  const refused = (d, ext = false) => ({ ...base, would_bind: false, is_ext_shared: ext, guard: { capture_ok: false, surface_ok: false, members_known: true, org_public: false, capture_basis: null, detail: detail(d) } });
  if (conversation_id === 'C_LEAD' && !state.createdNests.includes(nest_id)) return refused({ readers_total: 312, readers_absent: 306, members_total: 6 });
  if (conversation_id === 'C_SHARED') return ext_capture_enabled ? ok(false, { members_total: 9, members_not_readers: 4, externals: 4, ext_shared: true }) : refused({ members_total: 9, externals: 4, ext_shared: true }, true);
  if (conversation_id === 'C_REVOPS') return ok(false, { members_total: 18, members_not_readers: 11 });
  return ok(true, {});
}

/**
 * Answer every /surfaces call the Control room makes from one fake.
 * @param {import('@playwright/test').Page} page
 * @param {{ install?: 'none'|'pending'|'active', bindings?: Array<{conversation_id:string,nest_id:string}>, seeded?: string[], homeNestId?: string }} initial
 */
export async function stubSurfaces(page, initial = {}) {
  const state = {
    install: initial.install && initial.install !== 'none' ? { id: 'inst_fake', surface: 'slack', mode: 'manifest', status: initial.install, home_nest_id: initial.homeNestId ?? null } : null,
    creds: { client_id: initial.install === 'active', client_secret: initial.install === 'active', signing_secret: initial.install === 'active' },
    bindings: (initial.bindings ?? []).map((b, i) => ({ id: `bind_${i}`, install_id: 'inst_fake', status: 'active', conversation_kind: 'private_channel', conversation_name: null, ...b })),
    seeded: [...(initial.seeded ?? [])],
    createdNests: [],
    calls: [],
  };
  const manifest = { display_information: { name: 'Nest' }, settings: { event_subscriptions: { request_url: 'https://example.test/surfaces/slack/inst_fake/events' } } };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // Nests the test creates through the wizard ("Create a … nest for this channel")
  // are real; remember them so the fake guard lets them through.
  await page.route(
    (url) => pathOf(url) === '/nests',
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      const res = await route.fetch();
      const body = await res.json().catch(() => ({}));
      if (body?.nest?.id) state.createdNests.push(body.nest.id);
      await route.fulfill({ response: res, json: body });
    }
  );

  await page.route(
    (url) => pathOf(url).startsWith('/surfaces/') && pathOf(url) !== '/surfaces/settings',
    async (route, request) => {
      const p = pathOf(request.url());
      const m = request.method();
      const body = m === 'GET' ? {} : JSON.parse(request.postData() || '{}');
      if (m !== 'GET') state.calls.push({ method: m, path: p, body });

      if (p === '/surfaces/status') {
        return json(route, { enabled: true, installs: state.install ? [state.install] : [], bindings: { total: state.bindings.length, active: state.bindings.length, paused_guard: 0, paused_by_member: 0, removed: 0 }, org_name: 'Larkspur', slack_hosted: false, disclosure: "This server's administrators can read every nest." });
      }
      if (p === '/surfaces/bindings' && m === 'GET') return json(route, { bindings: state.bindings });
      if (p === '/surfaces/slack/installs' && m === 'POST') {
        state.install = { id: 'inst_fake', surface: 'slack', mode: 'manifest', status: 'pending', home_nest_id: body.home_nest_id };
        return json(route, { install_id: 'inst_fake', manifest, disclosure: '' }, 201);
      }
      if (p === '/surfaces/slack/installs/inst_fake' && m === 'GET') return json(route, { install: { ...state.install, team_id: null, credentials: state.creds }, manifest });
      if (p === '/surfaces/slack/installs/inst_fake/credentials' && m === 'PUT') {
        const stored = Object.keys(body).filter((k) => k in state.creds);
        for (const k of stored) state.creds[k] = true;
        return json(route, { stored, credentials: state.creds });
      }
      if (p === '/surfaces/slack/installs/inst_fake/oauth/start') {
        // Stubbed Slack OAuth: approve at once and come back, like the callback page.
        state.install = { ...state.install, status: 'active' };
        return route.fulfill({ status: 302, headers: { location: '/control-room?section=setup' } });
      }
      if (p === '/surfaces/slack/installs/inst_fake/channels') {
        return json(route, {
          truncated: false,
          channels: FAKE_CHANNELS.map((c) => {
            const b = state.bindings.find((x) => x.conversation_id === c.id);
            return { ...c, binding: b ? { id: b.id, nest_id: b.nest_id, status: b.status } : null };
          }),
        });
      }
      if (p === '/surfaces/bindings/preview') return json(route, previewFor(state, body));
      if (p === '/surfaces/bindings' && m === 'POST') {
        const b = { id: `bind_${state.bindings.length}`, install_id: 'inst_fake', conversation_id: body.conversation_id, nest_id: body.nest_id, status: 'active' };
        state.bindings.push(b);
        return json(route, { binding: b }, 201);
      }
      if (p === '/surfaces/seeds') return json(route, { seeds: [{ id: 'generic-team', version: 1, title: 'Generic team', layers: [], source: 'bundled', library_nest_id: null }] });
      if (p === '/surfaces/seeds/status') {
        const n = new URL(request.url()).searchParams.get('nest_id');
        const has = state.seeded.includes(n);
        return json(route, { nest_id: n, no_seed: !has, applied: has ? [{ seed_id: 'generic-team', version: 1, source: 'bundled', library_nest_id: null }] : [] });
      }
      if (p === '/surfaces/seeds/apply') {
        const items = [
          { kind: 'folder', target: 'decisions/', action: body.dry_run ? 'unchanged' : 'unchanged' },
          { kind: 'folder', target: 'people/', action: body.dry_run ? 'create' : 'created' },
          { kind: 'folder', target: 'projects/', action: body.dry_run ? 'create' : 'created' },
          { kind: 'folder', target: 'customers/', action: 'unchanged' },
          { kind: 'folder', target: 'how-we-work/', action: body.dry_run ? 'create' : 'created' },
          { kind: 'folder', target: 'agents/', action: body.dry_run ? 'create' : 'created' },
          { kind: 'context', target: 'CONTEXT.md', action: body.dry_run ? 'create' : 'created', title: 'Context' },
          ...['decision', 'owner', 'customer', 'renewal'].map((t) => ({ kind: 'definition', target: t, action: body.dry_run ? 'create' : 'created' })),
        ];
        if (!body.dry_run) state.seeded.push(body.nest_id);
        return json(route, { status: body.dry_run ? 'dry_run' : 'applied', nest_id: body.nest_id, drafts: 0, seed: { id: 'generic-team', version: 1, source: 'bundled', library_nest_id: null }, items, listener: { propose_folders: ['decisions/', 'people/', 'projects/', 'customers/', 'how-we-work/'], people_folders: [], admin_folders: [], domain_tags: [], never_propose: [], bindings_configured: 0 }, org_mirror: null });
      }
      return route.fallback();
    }
  );

  return state;
}

/** Serve /health from the real server with surfaces_enabled forced on (the rail gate). */
export async function stubSurfacesOn(page) {
  await page.route(
    (url) => pathOf(url) === '/health',
    async (route) => {
      try {
        const res = await route.fetch();
        const body = await res.json();
        body.surfaces_enabled = true;
        await route.fulfill({ response: res, json: body });
      } catch {
        // Aborted by a navigation.
      }
    }
  );
}

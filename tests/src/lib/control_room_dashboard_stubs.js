/**
 * Control Room dashboard stubs (po-1186 CR2) — the page's reads answered in
 * this browser, so a case doesn't depend on what the server holds: a paused
 * channel, a private-nest row, a seeded cold start, day zero.
 *
 * Answered: GET /rollups, /ledger, /ledger/:id, /nests/:id/{ledger,rollups},
 * /surfaces/bindings, /surfaces/status, /surfaces/cold-start,
 * /surfaces/nests/:id/budget, /surfaces/seeds/status. Shapes are the real
 * ones (API.md, "Agent event API and decision ledger" and "Control room
 * dashboard"). Nothing is written to the server.
 */

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};
const query = (url) => new URL(url).searchParams;

const ZERO = { entries: 0, runs: 0, failed: 0, no_op: 0, propose: 0, act: 0, escalate: 0, error: 0, none: 0, proposals: 0, approved: 0, edited: 0, rejected: 0, expired: 0, pending: 0, withdrawn: 0, cost_usd: 0, tokens: 0 };
const NEST = 'nest_company';
const today = () => new Date().toISOString().slice(0, 10);
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();

function bindings({ paused }) {
  return [
    { id: 'bnd_eng', install_id: 'i1', nest_id: NEST, conversation_id: 'C1', conversation_kind: 'public_channel', conversation_name: 'eng-platform', status: 'active', guard_detail: { members_total: 41, readers_total: 44 } },
    ...(paused
      ? [{ id: 'bnd_onb', install_id: 'i1', nest_id: NEST, conversation_id: 'C2', conversation_kind: 'public_channel', conversation_name: 'onboarding', status: 'paused_guard', guard_detail: { members_total: 25, readers_total: 312, readers_absent: 288, guests: 0, externals: 1 } }]
      : []),
  ];
}

const ENTRIES = [
  {
    entry_id: 'run_external',
    at: at(2),
    nest: { id: NEST, label: 'Company' },
    agent: { node_id: 'nodes/agents/claude-code-priya', name: 'Claude Code · Priya', source: 'external' },
    run: { id: 'run_external', outcome: 'succeeded', cost_usd: 0.11, external_ref: 'cc-session-1f8b4' },
    verdict: { code: 'propose', reason_code: 'new_decision', kinds: null, message_count: null },
    decision: { verdict: 'propose', reason_code: 'new_decision', confidence: 0.8, summary: 'Moved feature flags to flags/ service', evidence: [{ kind: 'url', ref: 'https://github.com/larkspur/app/pull/412' }] },
    proposal: { id: 'rv_1', title: 'nodes/decisions/flags-service', state: 'approved', edited: false, counts: { proposals: 1, approved: 1 } },
    review: { by: 'jamie@larkspur.example', reason: null, at: at(1) },
    commit: { node_id: 'nodes/decisions/flags-service', version: 1 },
    source: { kind: 'agent', label: 'cc-session-1f8b4', url: null },
    redacted: null,
  },
  {
    entry_id: 'win_private',
    at: at(3),
    nest: { id: 'nest_dm', label: 'DM · private nest · title hidden' },
    agent: { node_id: 'nodes/agents/listener-dm', name: 'DM listener', source: 'surfaces' },
    run: { id: 'run_dm', outcome: 'succeeded', cost_usd: 0.002 },
    verdict: { code: 'propose', reason_code: 'proposed', kinds: ['fact'], message_count: 4 },
    decision: null,
    proposal: { id: 'p_dm', state: 'approved', edited: false, counts: { proposals: 1, approved: 1 } },
    review: { at: at(2.8) },
    commit: { version: 1 },
    redacted: 'n1',
  },
  {
    entry_id: 'win_noop',
    at: at(4),
    nest: { id: NEST, label: 'Company' },
    agent: { node_id: 'nodes/agents/listener-company', name: 'Company listener', source: 'surfaces' },
    run: { id: 'run_noop', outcome: 'succeeded', cost_usd: 0.003 },
    verdict: { code: 'no_op', reason_code: 'chatter', kinds: [], message_count: 12 },
    decision: null,
    proposal: null,
    review: null,
    commit: null,
    source: { kind: 'slack', label: '#eng-platform', url: null },
    redacted: null,
  },
];

function totalsOf(entries) {
  const t = { ...ZERO };
  for (const e of entries) {
    t.entries += 1;
    t.runs += 1;
    if (e.verdict.code && t[e.verdict.code] !== undefined) t[e.verdict.code] += 1;
    if (e.proposal?.state === 'approved') t.approved += 1;
    t.proposals += e.proposal ? 1 : 0;
    t.cost_usd += e.run?.cost_usd ?? 0;
  }
  return t;
}

function rollupsFor(url, empty) {
  const q = query(url);
  const by = q.get('by') || 'agent';
  const grain = q.get('grain') || 'day';
  const source = q.get('source');
  const verdict = q.get('verdict');
  let entries = empty ? [] : ENTRIES.filter((e) => (!source || e.agent.source === source) && (!verdict || e.verdict.code === verdict));
  const groups = new Map();
  for (const e of entries) {
    const key = by === 'agent' ? e.agent.node_id : by === 'nest' ? e.nest.id : by === 'binding' ? 'bnd_eng' : by === 'reason' ? e.verdict.reason_code : 'all';
    const g = groups.get(key) ?? { key, label: by === 'agent' ? e.agent.name : by === 'nest' ? e.nest.label : null, nest_id: by === 'reason' || by === 'none' ? null : e.nest.id, list: [], source: e.agent.source, last_at: e.at };
    g.list.push(e);
    if (e.at > g.last_at) g.last_at = e.at;
    groups.set(key, g);
  }
  const rows = [...groups.values()].map((g) => ({ bucket: today(), key: g.key, label: g.label, nest_id: g.nest_id, last_at: g.last_at, source: g.source, ...totalsOf(g.list) }));
  return { api_version: '2026-11', grain, by, range: { from: q.get('from'), to: q.get('to') }, rows, totals: totalsOf(entries), reconciles_with: '/ledger' };
}

function trace(id) {
  const e = ENTRIES.find((x) => x.entry_id === id);
  if (!e) return null;
  return {
    api_version: '2026-11',
    entry: e,
    chain: {
      run: { id: e.run.id, agent_node: e.agent.node_id, status: 'succeeded', outcome: 'succeeded', started_at: e.at, finished_at: e.at, cost_usd: e.run.cost_usd, external_ref: e.run.external_ref ?? null },
      verdict: { ...e.verdict, decision: e.decision },
      proposal: e.proposal ? { review_id: 'rv_1', node_id: 'nodes/decisions/flags-service', version: 1, state: 'approved', count: 1 } : null,
      review: e.review ? { state: 'approved', by: e.review.by, reason: null, at: e.review.at } : null,
      version: e.commit ? { node_id: e.commit.node_id, version: 1, author: 'jamie@larkspur.example', at: e.review.at } : null,
      source: { kind: 'agent', label: e.run.external_ref ?? null },
    },
    steps: [
      { seq: 1, action: 'read', node_id: 'nodes/decisions/ci-matrix', edge_id: null, detail: {}, at: e.at },
      { seq: 2, action: 'decision', node_id: null, edge_id: null, detail: { verdict: 'propose', reason_code: 'new_decision' }, at: e.at },
      { seq: 3, action: 'proposal', node_id: null, edge_id: null, detail: { review_id: 'rv_1', node_id: 'nodes/decisions/flags-service' }, at: e.at },
    ],
    gaps: [],
  };
}

const COLD = {
  seeded: [
    {
      nest_id: NEST,
      nest_label: 'Company',
      redacted: null,
      no_seed: false,
      seed: { id: 'generic-team', version: 1, applied_at: at(18 * 24) },
      folders: [
        { path: 'decisions/', approved: 23, first_approved_at: at(17 * 24) },
        { path: 'customers/', approved: 14, first_approved_at: at(16 * 24) },
        { path: 'people/', approved: 11, first_approved_at: at(16 * 24) },
        { path: 'projects/', approved: 9, first_approved_at: at(15 * 24) },
        { path: 'how-we-work/', approved: 0, first_approved_at: null },
      ],
      coverage: { covered: 4, total: 5 },
      first_approved: { node_id: 'nodes/decisions/x', at: at(18 * 24 - 2.2), after_seed_ms: (2 * 60 + 14) * 60000 },
      mirror: { people: { proposed: 14, accepted: 11 }, areas: { proposed: 10, accepted: 8 } },
      cumulative: Array.from({ length: 19 }, (_, i) => ({ day: new Date(Date.now() - (18 - i) * 86400000).toISOString().slice(0, 10), approved: i * 3 })),
    },
  ],
  none: [],
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ empty?: boolean, paused?: boolean, coldStart?: 'seeded' | 'none' }} opts
 */
export async function stubDashboard(page, opts = {}) {
  // Later routes win (Playwright runs the newest matching handler first), so a
  // second call in one case replaces the first's answers.
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(
    (url) => /^\/(rollups|ledger)(\/|$)|^\/nests\/[^/]+\/(rollups|ledger)$|^\/surfaces\/(bindings|status|cold-start|seeds\/status|settings)$|^\/surfaces\/nests\/[^/]+\/budget$/.test(pathOf(url)),
    async (route, request) => {
      if (request.method() !== 'GET') return route.fallback();
      const url = request.url();
      const p = pathOf(url);
      if (/\/rollups$/.test(p)) return json(route, rollupsFor(url, opts.empty));
      const traceMatch = /^\/ledger\/(.+)$/.exec(p);
      if (traceMatch) {
        const t = opts.empty ? null : trace(decodeURIComponent(traceMatch[1]));
        return t ? json(route, t) : json(route, { error: 'Ledger entry not found' }, 404);
      }
      if (/\/ledger$/.test(p)) {
        const list = opts.empty ? [] : ENTRIES;
        return json(route, { api_version: '2026-11', range: {}, entries: list, next_cursor: null, totals: totalsOf(list) });
      }
      if (p === '/surfaces/bindings') return json(route, { bindings: opts.empty ? [] : bindings(opts) });
      if (p === '/surfaces/status') {
        const bs = opts.empty ? [] : bindings(opts);
        return json(route, { enabled: true, installs: [], bindings: { total: bs.length, active: bs.filter((b) => b.status === 'active').length, paused_guard: bs.filter((b) => b.status === 'paused_guard').length, paused_by_member: 0, removed: 0 }, org_name: 'Larkspur', slack_hosted: false, disclosure: '' });
      }
      if (p === '/surfaces/cold-start') return json(route, { api_version: '2026-11', nests: opts.empty ? [] : COLD[opts.coldStart ?? 'seeded'] });
      if (p === '/surfaces/seeds/status') return json(route, { nest_id: NEST, no_seed: false, applied: [] });
      if (p === '/surfaces/settings') return json(route, { settings: { quiet_minutes: 20, buffer_ttl_hours: 24, reviewer_daily_cards: 2, conversation_daily_cards: 3, dm_capture: false } });
      if (/\/budget$/.test(p)) return json(route, { budget: { nest_id: NEST, month: today().slice(0, 7), cap_micros: 40e6, spent_micros: 11.42e6, reserved_micros: 0, alerted_90: false, alerted_100: false } });
      return route.fallback();
    }
  );
  // The nest names the page shows ("Company") come from /nests.
  await page.route(
    (url) => pathOf(url) === '/nests',
    async (route, request) => {
      if (request.method() !== 'GET') return route.fallback();
      return json(route, { nests: [{ id: NEST, name: 'Company', permission: 'owner', is_owner: true }] });
    }
  );
}

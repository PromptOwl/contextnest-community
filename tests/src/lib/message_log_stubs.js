/**
 * Message Log Stubs — forced message-log states
 *
 * Most of the Message log suite reads the real server-wide log, which on a
 * shared server is long and grows with every notification (the suite's own
 * included). A few states can't be arranged from it:
 *
 *   - one row of every shape (a persona sender, several recipients, each
 *     machine subject the page turns into words, every status) and a message
 *     with every optional field, or none, or no stored body;
 *   - a failed read, and a read slow enough to watch Refresh while it loads;
 *   - an exact last page on either tab (the real totals keep moving).
 *
 * Those are served here, at the network boundary: the real page, the real
 * response shapes, only the data is ours. Each read is recorded with its
 * query, so a test can check what the page asked for.
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

const isApi = (request) => request.method() === 'GET' && request.resourceType() !== 'document';

/** A list row shaped like `GET /admin/messages` returns one (no body; `has_body`). */
export function messageRow(i, overrides = {}) {
  return {
    id: `stub-msg-${i}`,
    channel: 'email',
    sender_kind: 'system',
    sender: null,
    recipients: [`stub-${i}@example.com`],
    subject: `Stub message ${i}`,
    status: 'sent',
    provider_id: null,
    error: null,
    nest_id: null,
    nest_name: null,
    node_id: null,
    run_id: null,
    via_proxy: null,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
    has_body: true,
    ...overrides,
  };
}

/** One message as `GET /admin/messages/:id` returns it (with `body`). */
export function messageDetail(i, overrides = {}) {
  const { has_body: _drop, ...row } = messageRow(i);
  return { ...row, body: `Body of stub message ${i}.`, ...overrides };
}

/** An access-log row shaped like `GET /admin/messages/views` returns one. */
export function viewRow(i, overrides = {}) {
  return {
    id: `stub-view-${i}`,
    viewer: 'stub-admin@example.com',
    action: 'list',
    filters: { via: 'rest' },
    message_id: null,
    at: new Date(Date.now() - i * 60_000).toISOString(),
    ...overrides,
  };
}

const pageOf = (url) => {
  const q = new URL(url).searchParams;
  const limit = Number(q.get('limit') ?? 50) || 50;
  const offset = Number(q.get('offset') ?? 0) || 0;
  return { q, limit, offset };
};

/**
 * Serve the message list from `rows` — filtered by channel, sender kind,
 * status and q (subject or recipient), and paged by limit/offset the way the
 * server does — or force one response (`{ status, body }`).
 * @param {import('@playwright/test').Page} page
 * @param {any[] | {status: number, body: any}} source
 * @param {{ retention_days?: number, store_bodies?: boolean }} [meta]
 * @returns {Promise<{ reads: Record<string, string|null>[] }>}
 */
export async function stubMessageLog(page, source, meta = {}) {
  const reads = [];
  await page.route(
    (url) => pathOf(url) === '/admin/messages',
    async (route, request) => {
      if (!isApi(request)) return route.fallback();
      const { q, limit, offset } = pageOf(request.url());
      const query = Object.fromEntries(['channel', 'sender_kind', 'status', 'q', 'limit', 'offset'].map((k) => [k, q.get(k)]));
      reads.push(query);
      if (!Array.isArray(source)) return answer(route, source.status ?? 200, source.body);
      const text = (query.q ?? '').toLowerCase();
      const matching = source.filter(
        (r) =>
          (!query.channel || r.channel === query.channel) &&
          (!query.sender_kind || r.sender_kind === query.sender_kind) &&
          (!query.status || r.status === query.status) &&
          (!text || String(r.subject ?? '').toLowerCase().includes(text) || r.recipients.join(' ').toLowerCase().includes(text))
      );
      return answer(route, 200, {
        total: matching.length,
        limit,
        offset,
        retention_days: meta.retention_days ?? 30,
        store_bodies: meta.store_bodies ?? true,
        messages: matching.slice(offset, offset + limit),
      });
    }
  );
  return { reads };
}

/**
 * Pass the real list read through, with the retention / bodies settings it
 * reports replaced — the footer's two states without changing the server.
 */
export async function overrideMessageLogMeta(page, meta) {
  await page.route(
    (url) => pathOf(url) === '/admin/messages',
    async (route, request) => {
      if (!isApi(request)) return route.fallback();
      try {
        const res = await route.fetch();
        const body = await res.json();
        await answer(route, res.status(), { ...body, ...meta });
      } catch {
        /* aborted */
      }
    }
  );
}

/**
 * Serve `GET /admin/messages/:id` from `messages` (by id); an unknown id is
 * the server's 404 "Message not found.".
 * @param {Record<string, any>} messages
 */
export async function stubMessageDetail(page, messages) {
  const reads = [];
  await page.route(
    (url) => pathOf(url).startsWith('/admin/messages/') && pathOf(url) !== '/admin/messages/views',
    async (route, request) => {
      if (!isApi(request)) return route.fallback();
      const id = decodeURIComponent(pathOf(request.url()).split('/').pop());
      reads.push(id);
      const message = messages[id];
      return message ? answer(route, 200, { message }) : answer(route, 404, { error: 'Message not found.' });
    }
  );
  return { reads };
}

/** Serve the access log from `views`, paged by limit/offset. */
export async function stubMessageViews(page, views) {
  const reads = [];
  await page.route(
    (url) => pathOf(url) === '/admin/messages/views',
    async (route, request) => {
      if (!isApi(request)) return route.fallback();
      const { limit, offset } = pageOf(request.url());
      reads.push({ limit, offset });
      return answer(route, 200, { total: views.length, limit, offset, views: views.slice(offset, offset + limit) });
    }
  );
  return { reads };
}

/**
 * Hold every list read until the returned `release()` is called, then pass it
 * through to the real server. Used to watch the page while it loads.
 */
export async function holdMessageLog(page) {
  let release;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => pathOf(url) === '/admin/messages',
    async (route, request) => {
      if (!isApi(request)) return route.fallback();
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

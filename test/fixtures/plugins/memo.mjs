// Test plugin for the Community host. Plain ESM, no SDK import: the host
// validates the manifest, so a fixture can stay dependency-free.
export const state = { items: [], hits: [], fail: false, seen: [], gate: null };
export default {
  manifest: {
    name: "memo",
    version: "0.0.1",
    displayName: "Memo",
    description: "test plugin",
    capabilities: ["pull", "webhook", "search"],
    itemKinds: ["document"],
    settings: {
      type: "object",
      required: ["prefix"],
      properties: {
        prefix: { type: "string", title: "Prefix" },
        token: { type: "string", title: "Token", "x-secret": true },
      },
    },
    webhook: { verify: "custom", signatureHeader: "x-memo-sig" },
    cursor: { n: "count" },
  },
  validateSettings(s) {
    if (typeof s.prefix !== "string" || !s.prefix) throw new Error("prefix is required");
  },
  async healthcheck(ctx) {
    return ctx.settings.token === "sekrit" ? { ok: true } : { ok: false, detail: "bad token" };
  },
  pull(ctx, cursor) {
    const n = (cursor && cursor.n) || 0;
    const r = {
      nextCursor: cursor,
      async *[Symbol.asyncIterator]() {
        state.seen.push({ settings: { ...ctx.settings }, cursor, nestId: ctx.nestId });
        if (state.fail) throw new Error("upstream exploded");
        if (state.gate) await state.gate;
        if (ctx.settings.token !== "sekrit") throw new Error("token not resolved");
        for (const it of state.items) yield { ...it, title: `${ctx.settings.prefix} ${it.title}` };
        r.nextCursor = { n: n + 1 };
      },
    };
    return r;
  },
  async webhook(ctx, req) {
    if (req.headers["x-memo-sig"] !== req.secret) throw new Error("bad signature");
    const body = JSON.parse(req.body);
    return [{ externalId: body.id, kind: "document", title: body.title, occurredAt: "2026-09-15T00:00:00Z", body: body.text, provenance: { fetchedAt: "2026-09-15T00:00:00Z", hash: body.hash || "w1" } }];
  },
  async search(ctx, q) {
    return state.hits.filter((h) => h.title.toLowerCase().includes(q.text.toLowerCase()));
  },
  async fetchOne(ctx, id) {
    return { externalId: id, kind: "document", title: `Promoted ${id}`, occurredAt: "2026-09-15T00:00:00Z", body: "promoted body", provenance: { fetchedAt: "2026-09-15T00:00:00Z", hash: "p1" } };
  },
};

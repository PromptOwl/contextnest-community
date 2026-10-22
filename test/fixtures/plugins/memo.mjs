// Test plugin for the Community host (Nest Plugins, Slice A). Plain ESM, no
// SDK import: the engine host validates the manifest, so a fixture stays
// dependency-free. `state` lets a test drive what the next pull yields.
export const state = { items: [], fail: false, seen: [], gate: null };
export default {
  manifest: {
    name: "memo",
    version: "0.0.1",
    displayName: "Memo",
    description: "test plugin",
    capabilities: ["pull"],
    itemKinds: ["document"],
    settings: {
      type: "object",
      required: ["prefix"],
      properties: {
        prefix: { type: "string", title: "Prefix" },
        token: { type: "string", title: "Token", "x-secret": true },
      },
    },
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
};

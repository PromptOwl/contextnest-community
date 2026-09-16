// OAuth-declaring test plugin: a "custom" provider pointing at a local fake.
export const state = { items: [], seenTokens: [] };
export default {
  manifest: {
    name: "oauthy",
    version: "0.0.1",
    displayName: "OAuthy",
    description: "test plugin that needs a connected account",
    capabilities: ["pull"],
    itemKinds: ["document"],
    settings: { type: "object", properties: { folder: { type: "string", title: "Folder" } } },
    oauth: { provider: "custom", scopes: ["read"], authorizationUrl: process.env.FAKE_OAUTH_BASE + "/authorize", tokenUrl: process.env.FAKE_OAUTH_BASE + "/token" },
  },
  pull(ctx) {
    return {
      async *[Symbol.asyncIterator]() {
        state.seenTokens.push(ctx.settings.accessToken);
        if (!ctx.settings.accessToken) throw new Error("no accessToken injected");
        for (const it of state.items) yield it;
      },
    };
  },
};

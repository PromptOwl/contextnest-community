import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Setup hooks recompile the app (vi.resetModules + re-import) and seed
    // users/vault index; under parallel cold load the default 10s is too tight.
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});

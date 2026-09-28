import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Playwright e2e specs (tests/**/*.spec.js) run via `npm run
    // test:playwright`, not vitest — the default include glob would pick
    // them up and choke on @playwright/test's test() outside its runner.
    exclude: [...configDefaults.exclude, "tests/**"],
    // Setup hooks recompile the app (vi.resetModules + re-import) and seed
    // users/vault index; under parallel cold load the default 10s is too tight.
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});

import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // UI component tests import through the UI's own "@/…" alias (ui/vite.config.ts).
  // The server never uses "@/", so it can't clash.
  resolve: { alias: { "@": fileURLToPath(new URL("./ui/src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
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
    // CI: console output only from failing tests, so the failure isn't buried in a log
    // GitHub truncates; JSON feeds the step summary (tests/scripts/vitest-ci-summary.mjs).
    ...(process.env.GITHUB_ACTIONS
      ? {
          silent: "passed-only" as const,
          reporters: ["default", "github-actions", ["json", { outputFile: "vitest-results.json" }]],
        }
      : {}),
  },
});

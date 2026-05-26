import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ── .env loading ────────────────────────────────────────────────────────
// Load .env before any getter reads process.env. Try cwd first (typical
// dev: `npm run dev` from project root), then fall back to the directory
// next to the compiled entrypoint (packaged `node dist/index.js` runs).
// override: true so .env wins over stale OS-level vars — EXCEPT under
// vitest, where each test sets DATA_ROOT/PROMPTOWL_KEY before
// vi.resetModules() re-imports this file; overriding would clobber
// that test setup and the suite would all read the dev .env values.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envCandidates = [
  join(process.cwd(), ".env"),
  join(__dirname, "..", ".env"),
];
const envFileLoaded = envCandidates.find((p) => existsSync(p)) || null;
const isTestRun = !!process.env.VITEST;
if (envFileLoaded && !isTestRun) {
  dotenv.config({ path: envFileLoaded, override: true });
}
if (!isTestRun) {
  console.log(
    `[config] dotenv: ${envFileLoaded ? `loaded ${envFileLoaded}` : "no .env file found"}`,
  );
}

function dataRoot() {
  return process.env.DATA_ROOT || join(process.cwd(), "data");
}

export const config = {
  get PORT() {
    return parseInt(process.env.PORT || "3838", 10);
  },
  get DATA_ROOT() {
    return dataRoot();
  },
  get DATABASE_PATH() {
    return (
      process.env.DATABASE_PATH || join(dataRoot(), "community.db")
    );
  },
  get PROMPTOWL_API_URL() {
    return process.env.PROMPTOWL_API_URL || "https://app.promptowl.ai";
  },
  get PROMPTOWL_KEY() {
    return process.env.PROMPTOWL_KEY || "";
  },
  /**
   * Path to the .env file the server reads its config from. Used by
   * the license install flow to persist PROMPTOWL_KEY alongside any
   * existing env vars, instead of a separate sidecar file.
   */
  get ENV_FILE_PATH() {
    return process.env.ENV_FILE_PATH || join(process.cwd(), ".env");
  },
  get TELEMETRY_ENABLED() {
    return process.env.TELEMETRY_ENABLED !== "false";
  },
  get TELEMETRY_INTERVAL_MS() {
    return parseInt(process.env.TELEMETRY_INTERVAL_MS || "3600000", 10);
  },
  /**
   * Optional custom logo URL shown in UI header + login screen.
   * Must be an absolute https://, http://, or data:image/… URL. Other
   * schemes (file://, javascript:, relative paths) are rejected with a
   * warning so an operator typo doesn't silently break the favicon.
   * When unset or invalid, the UI falls back to the bundled icon.
   */
  get LOGO_URL(): string | null {
    const raw = process.env.LOGO_URL?.trim();
    if (!raw) return null;
    const ok = /^(https?:\/\/|data:image\/)/i.test(raw);
    if (!ok) {
      console.warn(
        `[config] LOGO_URL rejected: must start with https://, http://, or data:image/ (got "${raw}"). Falling back to default logo.`,
      );
      return null;
    }
    return raw;
  },
  get AUTH_MODE(): "open" | "key" {
    // Default is "key" — requires an explicit AUTH_MODE=open to run
    // without authentication. Safer default for public deployments;
    // local/dev users opt in explicitly.
    return (process.env.AUTH_MODE || "key") as "open" | "key";
  },
  /**
   * CORS origin allowlist. Comma-separated list of origins or "*".
   * Defaults to "*" in open mode (read-heavy, no credentials to steal)
   * and a locked-down list in key mode (Bearer tokens flow, CSRF matters).
   */
  get CORS_ORIGINS(): string[] | "*" {
    const raw = process.env.CORS_ORIGINS;
    if (raw === "*") return "*";
    if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
    // Sensible defaults
    if ((process.env.AUTH_MODE || "key") === "open") return "*";
    return ["http://localhost:5173", "http://localhost:3838"];
  },
  /**
   * Max JSON body size in bytes. Prevents DoS via giant payloads.
   * Default: 10 MB. Override via MAX_BODY_BYTES env.
   */
  get MAX_BODY_BYTES() {
    return parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
  },
};

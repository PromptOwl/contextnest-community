import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ── .env loading ────────────────────────────────────────────────────────
// Load .env before any getter reads process.env. Try cwd first (typical
// dev: `npm run dev` from project root), then fall back to the directory
// next to the compiled entrypoint (packaged `node dist/index.js` runs).
// override: true so .env wins over stale OS-level vars.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envCandidates = [
  join(process.cwd(), ".env"),
  join(__dirname, "..", ".env"),
];
const envFileLoaded = envCandidates.find((p) => existsSync(p)) || null;
if (envFileLoaded) {
  dotenv.config({ path: envFileLoaded, override: true });
}
console.log(
  `[config] dotenv: ${envFileLoaded ? `loaded ${envFileLoaded}` : "no .env file found"}`,
);

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
  get TELEMETRY_ENABLED() {
    return process.env.TELEMETRY_ENABLED !== "false";
  },
  get TELEMETRY_INTERVAL_MS() {
    return parseInt(process.env.TELEMETRY_INTERVAL_MS || "3600000", 10);
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

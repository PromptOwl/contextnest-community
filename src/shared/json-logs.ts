import { format } from "node:util";

const LEVELS = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;

/** LOG_FORMAT=json: every console call becomes one JSON line a log shipper can
 *  parse. `severity` + `message` are what Cloud Logging and Datadog read;
 *  message keeps console's own formatting (an Error prints its stack). */
export function installJsonLogs(
  write: (stream: "stdout" | "stderr", line: string) => void = (s, l) => process[s].write(l),
): void {
  for (const [method, level] of Object.entries(LEVELS) as [keyof typeof LEVELS, string][]) {
    const stream = level === "warn" || level === "error" ? "stderr" : "stdout";
    console[method] = (...args: unknown[]) =>
      write(stream, JSON.stringify({ time: new Date().toISOString(), level, severity: level.toUpperCase(), message: format(...args) }) + "\n");
  }
}

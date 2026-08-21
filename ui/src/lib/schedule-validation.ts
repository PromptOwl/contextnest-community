/**
 * Client-side check for the Agent/Skill "Schedule (cron / interval)" field.
 * The value itself is opaque to this server (an external orchestrator parses
 * it) — this never rewrites what the user typed, it only tells them whether
 * it looks like a standard 5-field cron expression / `@every` interval /
 * `@daily`-style alias, and what that would mean, before they save it.
 */

export type ScheduleValidation =
  | { kind: "empty" }
  | { kind: "valid"; description: string }
  | { kind: "invalid"; error: string };

const CRON_ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

// Each cron field has its own valid range by position — a value that's fine
// in the hour field (e.g. 23) is out of range in the month field.
const CRON_FIELD_SPECS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12 },
  { label: "day of week", min: 0, max: 7 }, // 0 and 7 both mean Sunday
];

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad2 = (n: string) => n.padStart(2, "0");
const isNum = (s: string) => /^\d+$/.test(s);

/** One comma-separated field, e.g. `*`, `5`, `1-5`, `*/15`, `1-10/2`. */
function validateCronField(
  raw: string,
  spec: (typeof CRON_FIELD_SPECS)[number],
): string | null {
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) {
      return `"${part}" isn't a valid ${spec.label} (use a number, a range like 1-5, ${"`*`"}, or ${"`*/n`"})`;
    }
    const [, range, step] = m;
    if (step !== undefined && Number(step) <= 0) {
      return `the step in "${part}" must be greater than zero`;
    }
    if (range !== "*") {
      const bounds = range.split("-").map(Number);
      for (const n of bounds) {
        if (n < spec.min || n > spec.max) {
          return `${spec.label} must be between ${spec.min} and ${spec.max} (got ${n} in "${part}")`;
        }
      }
      if (bounds.length === 2 && bounds[0] > bounds[1]) {
        return `the range "${part}" is backwards — ${bounds[0]} is after ${bounds[1]}`;
      }
    }
  }
  return null;
}

function describeCron(fields: string[]): string {
  const [min, hour, dom, mon, dow] = fields;
  const allWild = dom === "*" && mon === "*" && dow === "*";

  if (min === "*" && hour === "*" && allWild) return "Runs every minute";

  if (isNum(min) && isNum(hour)) {
    const time = `${pad2(hour)}:${pad2(min)}`;
    if (allWild) return `Runs daily at ${time}`;
    if (dom === "*" && mon === "*" && isNum(dow)) {
      return `Runs weekly on ${DOW_NAMES[Number(dow) % 7]} at ${time}`;
    }
    if (isNum(dom) && mon === "*" && dow === "*") {
      return `Runs monthly on day ${dom} at ${time}`;
    }
    if (isNum(dom) && isNum(mon) && dow === "*") {
      return `Runs yearly on ${MONTH_NAMES[Number(mon)]} ${dom} at ${time}`;
    }
  }

  if (min.startsWith("*/") && hour === "*" && allWild) {
    return `Runs every ${min.slice(2)} minutes`;
  }
  if (isNum(min) && hour === "*" && allWild) {
    return min === "0" ? "Runs hourly, on the hour" : `Runs hourly at minute ${min}`;
  }
  if (isNum(min) && hour.startsWith("*/") && allWild) {
    return `Runs at minute ${min} past every ${hour.slice(2)} hours`;
  }

  return "Runs on a custom schedule (minute hour day-of-month month day-of-week)";
}

function validateCronExpression(value: string): ScheduleValidation {
  const expanded = CRON_ALIASES[value.toLowerCase()] ?? value;
  const fields = expanded.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      kind: "invalid",
      error: `A cron schedule needs 5 space-separated fields (minute hour day month weekday) — got ${fields.length}`,
    };
  }
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], CRON_FIELD_SPECS[i]);
    if (err) return { kind: "invalid", error: err };
  }
  return { kind: "valid", description: describeCron(fields) };
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** `@every 1h30m`, `@every 90s`, `@every 15m` — Go-style interval shorthand. */
function validateEveryInterval(value: string): ScheduleValidation {
  const body = value.slice("@every".length).trim();
  const re = /(\d+)(s|m|h|d)/gi;
  let match: RegExpExecArray | null;
  let totalSeconds = 0;
  let consumed = 0;
  while ((match = re.exec(body))) {
    totalSeconds += Number(match[1]) * DURATION_UNIT_SECONDS[match[2].toLowerCase()];
    consumed += match[0].length;
  }
  if (consumed === 0 || consumed !== body.replace(/\s+/g, "").length) {
    return {
      kind: "invalid",
      error: `"${body}" isn't a valid duration — use a number plus s/m/h/d, e.g. "15m" or "1h30m"`,
    };
  }
  if (totalSeconds <= 0) {
    return { kind: "invalid", error: "the interval must be greater than zero" };
  }

  const parts: string[] = [];
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (seconds) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);

  return { kind: "valid", description: `Runs every ${parts.join(" ")}` };
}

export function validateSchedule(rawValue: string): ScheduleValidation {
  const value = rawValue.trim();
  if (!value) return { kind: "empty" };
  if (value.toLowerCase().startsWith("@every")) {
    return validateEveryInterval(value);
  }
  return validateCronExpression(value);
}

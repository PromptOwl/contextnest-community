/**
 * Golden-snapshot support for the characterization suite (RC-19 / §2.9).
 *
 * A golden is a committed JSON fixture under test/characterization/__golden__/.
 * Normal runs assert every recorded response against it with toEqual — any
 * drift in status, the pinned headers or the (normalized) body sha256 fails.
 *
 * Capturing: run the suite once with CAPTURE_GOLDEN=1. In that mode the golden
 * comparison is skipped (every other assertion still runs), the observed
 * values are written back to the fixture, printed to stdout, and any key whose
 * value differs from what the fixture held before is listed. Commit the
 * rewritten fixture, then run again WITHOUT the flag — that run must be green.
 * A fixture value of "__RECAPTURE__" means "not derivable without running";
 * it always fails a normal run until a capture replaces it.
 *
 * Normalization (applied to header values and bodies before hashing) removes
 * only the things that legitimately vary run-to-run: the nest id, publish
 * slugs, UUIDs, timestamps and CSP nonces. Nothing else is touched.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { expect } from "vitest";

export const CAPTURE = process.env.CAPTURE_GOLDEN === "1";
export const RECAPTURE = "__RECAPTURE__";

const GOLDEN_DIR = join(process.cwd(), "test", "characterization", "__golden__");

export type Normalizer = (s: string) => string;

/** Build a normalizer that blanks the run-varying tokens. `literals` are exact
 *  strings (nest id, publish slugs, …) replaced by their label. */
export function makeNormalizer(literals: Record<string, string>): Normalizer {
  const pairs = Object.entries(literals)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    // Longest first so a slug that contains another literal is replaced whole.
    .sort((a, b) => b[1].length - a[1].length);
  return (input: string) => {
    let out = input;
    for (const [label, value] of pairs) out = out.split(value).join(`<${label}>`);
    // ISO-8601 and SQLite "YYYY-MM-DD HH:MM:SS" timestamps (optionally quoted).
    out = out.replace(
      /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      "<TS>",
    );
    out = out.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<UUID>",
    );
    out = out.replace(/'nonce-[A-Za-z0-9+/=_-]+'/g, "'nonce-<N>'");
    out = out.replace(/nonce="[A-Za-z0-9+/=_-]+"/g, 'nonce="<N>"');
    return out;
  };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** The pinned surface of one HTTP response. */
export type ResponseSnap = {
  status: number;
  contentType: string | null;
  csp: string | null;
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  xArtifactSnapshot: string | null;
  cacheControl: string | null;
  bodySha256: string;
  bodyLength: number;
};

export async function snapResponse(
  res: Response,
  norm: Normalizer,
): Promise<{ snap: ResponseSnap; body: string; normalizedBody: string }> {
  const body = await res.text();
  const normalizedBody = norm(body);
  const h = (name: string) => {
    const v = res.headers.get(name);
    return v === null ? null : norm(v);
  };
  return {
    body,
    normalizedBody,
    snap: {
      status: res.status,
      contentType: h("content-type"),
      csp: h("content-security-policy"),
      xContentTypeOptions: h("x-content-type-options"),
      referrerPolicy: h("referrer-policy"),
      xArtifactSnapshot: h("x-artifact-snapshot"),
      cacheControl: h("cache-control"),
      bodySha256: sha256(normalizedBody),
      bodyLength: normalizedBody.length,
    },
  };
}

/** One golden fixture file. */
export class Golden {
  private readonly path: string;
  private readonly expected: Record<string, unknown>;
  private readonly observed: Record<string, unknown> = {};

  constructor(private readonly name: string) {
    this.path = join(GOLDEN_DIR, `${name}.json`);
    this.expected = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>)
      : {};
  }

  /** Record `actual` under `key`; outside capture mode assert it equals the golden. */
  check(key: string, actual: unknown) {
    // Round-trip through JSON so the comparison sees exactly what the fixture can hold.
    const plain = JSON.parse(JSON.stringify(actual));
    this.observed[key] = plain;
    if (CAPTURE) return;
    expect(
      Object.prototype.hasOwnProperty.call(this.expected, key),
      `golden "${this.name}" has no entry "${key}" — run with CAPTURE_GOLDEN=1 to record it`,
    ).toBe(true);
    expect(plain, `golden ${this.name} → ${key}`).toEqual(this.expected[key]);
  }

  /** Call from afterAll. In capture mode, writes the fixture and reports what moved. */
  flush() {
    if (!CAPTURE) return;
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(this.observed).sort()) merged[key] = this.observed[key];
    const moved = Object.keys(merged).filter(
      (k) => JSON.stringify(merged[k]) !== JSON.stringify(this.expected[k]),
    );
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(this.path, JSON.stringify(merged, null, 2) + "\n");
    // eslint-disable-next-line no-console
    console.log(
      `[golden:${this.name}] wrote ${this.path}\n` +
        `[golden:${this.name}] keys that differ from the previous fixture: ${
          moved.length ? moved.join(", ") : "(none)"
        }\n` +
        JSON.stringify(merged, null, 2),
    );
  }
}

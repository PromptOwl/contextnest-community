/**
 * Slack Web API calls. One function, form-encoded POSTs, a 10 s timeout.
 * 429 → SurfaceRateLimited(Retry-After); `ok:false` → SlackApiError(code).
 * Nothing here logs a request or response body.
 */
import { SurfaceRateLimited } from "../../contract.js";

export const SLACK_API = "https://slack.com/api/";

export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`slack: ${code}`);
  }
}

/** What a log line may say about a failed call: Slack's code, or the error's class. Never its text. */
export function slackErrorCode(err: unknown): string {
  if (err instanceof SurfaceRateLimited) return "ratelimited";
  if (err instanceof SlackApiError) return /^[a-z0-9_]{1,60}$/i.test(err.code) ? err.code : "error";
  return err instanceof Error ? err.name : "error";
}

export async function slackCall(
  method: string,
  params: Record<string, string | number | boolean | null | undefined>,
  opts: { token?: string | null } = {},
): Promise<Record<string, any>> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${SLACK_API}${method}`, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(10_000) });
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    throw new SurfaceRateLimited(Number.isFinite(ra) && ra > 0 ? ra : 60);
  }
  let body: Record<string, any> | null = null;
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.ok !== true) throw new SlackApiError(String(body?.error ?? `http_${res.status}`));
  return body;
}

/**
 * Slack checks the client pair before the code, so a dummy code tells a wrong
 * key (invalid_client_id / bad_client_secret) from a good one (invalid_code).
 * Anything else (Slack down, rate limit) does not block a save.
 */
export async function refusedClientPair(clientId: string, clientSecret: string): Promise<{ field: "client_id" | "client_secret"; error: string } | null> {
  try {
    await slackCall("oauth.v2.access", { client_id: clientId, client_secret: clientSecret, code: "nest-key-check" });
    return null;
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === "invalid_client_id") return { field: "client_id", error: "Slack doesn't recognize this Client ID. Copy it again from your Slack app's Basic Information page." };
    if (code === "bad_client_secret") return { field: "client_secret", error: "Slack refused this Client secret for this Client ID. Copy it again from your Slack app's Basic Information page." };
    return null;
  }
}

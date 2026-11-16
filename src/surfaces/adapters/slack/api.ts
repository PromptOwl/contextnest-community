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

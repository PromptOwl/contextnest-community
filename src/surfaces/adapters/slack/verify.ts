/**
 * Slack request signing (https://api.slack.com/authentication/verifying-requests):
 * `v0=` HMAC-SHA256(signing secret, `v0:{timestamp}:{raw body}`), compared in
 * constant time, rejecting timestamps more than 300 s from now (replays).
 *
 * The same algorithm as the `slack` hook preset's private helper
 * (src/workflow/hook-routes.ts), which isn't exported and stays unchanged
 * (PRD §5.1); unlike that preset, a missing secret here fails closed.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const REPLAY_WINDOW_S = 300;

export function verifySlackSignature(
  secret: string | null | undefined,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  rawBody: string,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_S) return false;
  const mine = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`);
  const theirs = Buffer.from(signature);
  return mine.length === theirs.length && timingSafeEqual(mine, theirs);
}

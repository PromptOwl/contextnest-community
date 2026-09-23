import { getDb } from "../db/client.js";

/**
 * Seats in use, for license reporting (license contract v2).
 *
 * Every users row counts — the same number the 60s license check reports to
 * PromptOwl — so what PromptOwl bills and what the admin sees agree. Nothing
 * is ever refused on seats: going over the limit is a sales conversation
 * (a private admin notice, and a flag in PromptOwl's console), never a block
 * on the person trying to join.
 */
export async function countSeatsUsed(): Promise<number> {
  const row = (await getDb().get("SELECT COUNT(*) as c FROM users")) as
    | { c: number }
    | undefined;
  return Number(row?.c || 0);
}

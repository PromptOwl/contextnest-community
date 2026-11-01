/**
 * Per-nest model spend (PRD §4.8): before each judge call the worst-case
 * cost is reserved with a compare-and-set (spent + reserved + estimate must
 * stay under 90% of the monthly cap for organic windows, 100% for explicit
 * asks); after the call the reservation is released and the actual cost —
 * metered the way metacognition meters a run (model.ts estimateCostUsd) —
 * is recorded. BYOK nests meter the same way against their cap.
 *
 * At 90% and at 100% one Surfaces alert (surface_notices, counts only) and
 * one email to the nest's admins, once per threshold per month: the alerted_*
 * flags flip by compare-and-set, so concurrent judges can't double-send.
 */
import { getDb } from "../../db/client.js";
import { estimateCostUsd } from "../../metacognition/model.js";
import { nestAdminEmails } from "../../governance/review-service.js";
import { thresholdsCrossed } from "../core/budget.js";
import { recordNotice } from "./notices.js";

/** Default cap: $50 per nest per calendar month (§4.1, D10). */
export const DEFAULT_CAP_MICROS = 50_000_000;
/** Judge run limits (§4.1): the reservation is priced at these. */
export const MAX_INPUT_TOKENS = 16_000;
export const MAX_OUTPUT_TOKENS = 1_500;
/** Price used when the model isn't recognised: the dearest known (fail safe). */
const FALLBACK = { input: 10, output: 50 };

export function monthKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Micros for a usage on a model; unknown models priced at the fallback. */
export function costMicros(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const usd = estimateCostUsd(model, { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
  if (usd !== null) return Math.round(usd * 1_000_000);
  return Math.round(((input + cacheRead + cacheWrite) * FALLBACK.input + output * FALLBACK.output));
}

export function reservationMicros(model: string): number {
  return costMicros(model, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

async function ensureRow(nestId: string, month: string): Promise<void> {
  const cap = Number(process.env.SURFACES_DEFAULT_CAP_MICROS) > 0 ? Number(process.env.SURFACES_DEFAULT_CAP_MICROS) : DEFAULT_CAP_MICROS;
  await getDb().run(
    `INSERT INTO surface_nest_budgets (nest_id, month, cap_micros, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (nest_id, month) DO NOTHING`,
    [nestId, month, cap, new Date().toISOString(), new Date().toISOString()],
  );
}

export async function getBudget(nestId: string, now = Date.now()) {
  const month = monthKey(now);
  await ensureRow(nestId, month);
  return (await getDb().get("SELECT * FROM surface_nest_budgets WHERE nest_id = ? AND month = ?", [nestId, month])) as {
    nest_id: string;
    month: string;
    cap_micros: number;
    spent_micros: number;
    reserved_micros: number;
    alerted_90: number;
    alerted_100: number;
  };
}

/** Reserve `estimate` micros; false (and the threshold's alert) when it would cross the stop. */
export async function reserve(nestId: string, estimate: number, forced: boolean, now = Date.now()): Promise<boolean> {
  const month = monthKey(now);
  await ensureRow(nestId, month);
  const limit = forced ? "cap_micros" : "(cap_micros * 9) / 10";
  const r = await getDb().run(
    `UPDATE surface_nest_budgets SET reserved_micros = reserved_micros + ?, updated_at = ?
      WHERE nest_id = ? AND month = ? AND cap_micros > 0 AND spent_micros + reserved_micros + ? <= ${limit}`,
    [estimate, new Date(now).toISOString(), nestId, month, estimate],
  );
  if (r.changes > 0) return true;
  await alert(nestId, forced ? 100 : 90, month);
  return false;
}

/** Release the reservation and record what the call actually cost. */
export async function settle(nestId: string, estimate: number, actual: number, now = Date.now()): Promise<void> {
  const month = monthKey(now);
  const before = await getBudget(nestId, now);
  await getDb().run(
    `UPDATE surface_nest_budgets SET spent_micros = spent_micros + ?,
       reserved_micros = CASE WHEN reserved_micros >= ? THEN reserved_micros - ? ELSE 0 END, updated_at = ?
     WHERE nest_id = ? AND month = ?`,
    [actual, estimate, estimate, new Date(now).toISOString(), nestId, month],
  );
  const after = await getBudget(nestId, now);
  for (const t of thresholdsCrossed(Number(before.spent_micros), Number(after.spent_micros), Number(after.cap_micros))) await alert(nestId, t, month);
}

/** Release a reservation that was never used (no call made). */
export async function release(nestId: string, estimate: number, now = Date.now()): Promise<void> {
  await settle(nestId, estimate, 0, now);
}

async function alert(nestId: string, threshold: 90 | 100, month: string): Promise<void> {
  const col = threshold === 90 ? "alerted_90" : "alerted_100";
  const r = await getDb().run(`UPDATE surface_nest_budgets SET ${col} = 1 WHERE nest_id = ? AND month = ? AND ${col} = 0`, [nestId, month]);
  if (r.changes === 0) return;
  const b = await getBudget(nestId);
  let admins: string[] = [];
  try {
    admins = await nestAdminEmails(nestId);
  } catch {
    admins = [];
  }
  await recordNotice({
    kind: `budget_${threshold}`,
    audience: "admins",
    nestId,
    to: admins,
    detail: { threshold, month, cap_micros: Number(b.cap_micros), spent_micros: Number(b.spent_micros) },
    subject: threshold === 90 ? "Nest listening paused for this month (90% of the model budget)" : "Nest reached its model budget for this month",
    text:
      threshold === 90
        ? "This nest has used 90% of its monthly model budget. Nest has stopped reviewing conversations on its own until next month; explicit 🧠 requests still work. You can raise the cap in Surfaces."
        : "This nest has used its whole monthly model budget. Explicit 🧠 requests are paused too until next month, or until the cap is raised in Surfaces.",
  });
}

/** Tests only: put a nest's current month into a known state. */
export async function setBudgetForTest(
  nestId: string,
  v: { cap_micros?: number; spent_micros?: number; reserved_micros?: number; alerted_90?: number; alerted_100?: number },
): Promise<void> {
  const month = monthKey();
  await ensureRow(nestId, month);
  for (const [k, val] of Object.entries(v)) {
    if (!["cap_micros", "spent_micros", "reserved_micros", "alerted_90", "alerted_100"].includes(k)) continue;
    await getDb().run(`UPDATE surface_nest_budgets SET ${k} = ? WHERE nest_id = ? AND month = ?`, [val as number, nestId, month]);
  }
}

/** §4.1: the per-nest monthly cap is $0–$10,000 (micros); outside → SettingsError (422). */
export const MAX_CAP_MICROS = 10_000 * 1_000_000;

export async function setCap(nestId: string, capMicros: unknown, now = Date.now()) {
  const { SettingsError } = await import("../core/settings.js");
  if (typeof capMicros !== "number" || !Number.isInteger(capMicros) || capMicros < 0 || capMicros > MAX_CAP_MICROS) {
    throw new SettingsError("cap_micros must be a whole number of micros between 0 and 10000000000 ($0–$10,000)");
  }
  const month = monthKey(now);
  await ensureRow(nestId, month);
  await getDb().run("UPDATE surface_nest_budgets SET cap_micros = ?, updated_at = ? WHERE nest_id = ? AND month = ?", [capMicros, new Date(now).toISOString(), nestId, month]);
  return budgetView(await getBudget(nestId, now));
}

export function budgetView(b: Awaited<ReturnType<typeof getBudget>>) {
  return {
    nest_id: b.nest_id,
    month: b.month,
    cap_micros: Number(b.cap_micros),
    spent_micros: Number(b.spent_micros),
    reserved_micros: Number(b.reserved_micros),
    alerted_90: !!b.alerted_90,
    alerted_100: !!b.alerted_100,
  };
}

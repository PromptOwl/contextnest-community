/**
 * Background work after the 3 s ack (AC-INS-10): every event's heavy part
 * (profile fetches, gate, buffer, judge) runs here, tracked so shutdown and
 * tests can wait for it. A failure is logged by kind only — never with
 * message text (§4.4 "never logged").
 */
const inFlight = new Set<Promise<unknown>>();

export function track(p: Promise<unknown>, label = "work"): void {
  const q = p
    .catch((err) => {
      console.error(`[surfaces] ${label} failed: ${err instanceof Error ? err.name : "error"}`);
    })
    .finally(() => inFlight.delete(q));
  inFlight.add(q);
}

export async function waitForSurfacesWork(): Promise<void> {
  // Work can schedule more work (a judged window posts a card): drain fully.
  for (let i = 0; i < 50 && inFlight.size; i++) await Promise.allSettled([...inFlight]);
}

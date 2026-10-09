/**
 * One place a screen can say "ask me before you navigate away".
 *
 * The unsaved-edits dialog lived inside DocumentEditor and was wired only to
 * that component's own back arrow and breadcrumbs, so every other way out —
 * the header logo, the nav tabs, the account menu — dropped the edits without
 * a word. App routes every view change through `navigateGuarded`, so the
 * screen currently mounted gets asked first, whoever triggered the move.
 *
 * A guard returns true when it took the navigation over (it will run `proceed`
 * itself once the user answers) and false to let it through.
 */
type Guard = (proceed: () => void) => boolean;

let guard: Guard | null = null;
let bypassing = false;

/** Register (or clear, with null) the guard for the mounted screen. */
export function setNavGuard(g: Guard | null): void {
  guard = g;
}

export function navigateGuarded(run: () => void): void {
  if (!bypassing && guard && guard(run)) return;
  run();
}

/**
 * Run a navigation the guard has already asked about. React state settles
 * after the click handler returns, so a guard re-consulted inside the answer
 * would still read the document as dirty and ask a second time.
 */
export function bypassNavGuard(run: () => void): void {
  bypassing = true;
  try {
    run();
  } finally {
    bypassing = false;
  }
}

/**
 * Push vs. replace for a history write, keyed by "which node this view is
 * looking at" — null when it isn't looking at one (dashboard, a nest's own
 * overview, …). App's URL-sync effect always used to replace, so a wiki-link
 * hop from one document to another never earned its own history entry and
 * the browser's Back button skipped straight past it to whatever real entry
 * preceded the app session — sometimes the nest root, sometimes further back
 * still, depending on what that entry happened to be (CU-wdqcq02g19).
 *
 * Push only when the key actually changes to a different node; every other
 * write (same node again, or neither side is a node — a tab switch, leaving
 * a doc for the nest overview, …) still just replaces, matching the app's
 * existing one-entry-per-view default.
 */
export function historyWriteMode(
  prevNodeKey: string | null,
  nextNodeKey: string | null,
): "push" | "replace" {
  return prevNodeKey !== null && nextNodeKey !== null && nextNodeKey !== prevNodeKey
    ? "push"
    : "replace";
}

/**
 * Drop the leave guard's spare history entries once the commit that cleared
 * them has settled. If App navigated in that same commit, its URL sync already
 * reused the spare entry, and going back would reopen the page just left
 * (CU-wdqcq042m3) — so only an entry that is still parked gets dropped.
 */
export function dropParkedEntries(
  count: number,
  history: Pick<History, "state" | "go"> = window.history,
): void {
  setTimeout(() => {
    if ((history.state as any)?.cnLeaveGuard) history.go(-count);
  });
}

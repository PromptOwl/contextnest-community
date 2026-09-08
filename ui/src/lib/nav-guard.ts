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

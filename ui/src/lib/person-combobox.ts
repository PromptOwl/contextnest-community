/**
 * Enter-key decision for PersonCombobox, pulled out to a pure function so it
 * stays unit-testable without a render harness (vitest runs with
 * environment: "node", no jsdom/RTL).
 *
 * Enter either takes the highlighted suggestion, or — with nothing
 * highlighted — submits whatever was typed. Either way the caller must close
 * the suggestion list on "submit": leaving it open after a direct-address
 * submit is what let the dropdown reopen with an empty query once the field
 * was cleared post-add, re-querying /people/suggest("") and listing every
 * account over the collaborators list.
 */
export type PersonComboboxEnterAction =
  | { type: "pick"; index: number }
  | { type: "submit" };

export function personComboboxEnterAction(
  open: boolean,
  optionsCount: number,
  highlight: number,
): PersonComboboxEnterAction {
  if (open && highlight >= 0 && highlight < optionsCount) {
    return { type: "pick", index: highlight };
  }
  return { type: "submit" };
}

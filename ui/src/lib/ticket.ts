/** Ticket numbers live on a task as the server-assigned tag `#ticket:cmn-12`
 *  (see API.md → task_rules). The UI shows them as `CMN-12`. */
const TICKET_TAG = /^#?ticket:([a-z][a-z0-9]{1,5}-\d+)$/i;

export const isTicketTag = (tag: string): boolean => TICKET_TAG.test(tag.trim());

/** `["#community","#ticket:cmn-12"]` → `"CMN-12"`; undefined when unnumbered. */
export function ticketOf(tags: readonly string[] | undefined): string | undefined {
  for (const t of tags ?? []) {
    const m = TICKET_TAG.exec(t.trim());
    if (m) return m[1]!.toUpperCase();
  }
  return undefined;
}

/** Tags worth showing as chips: the ticket tag is shown as the ID instead. */
export const visibleTags = (tags: readonly string[]): string[] => tags.filter((t) => !isTicketTag(t));

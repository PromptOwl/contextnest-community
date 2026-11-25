/** A person's display name from a roster, matched case-insensitively on
 *  email; the email itself when there's no match or no name set. */
export function displayNameFor(
  email: string,
  people: Array<{ email: string; name?: string | null }> = [],
): string {
  const lower = email.toLowerCase();
  // An agent's internal address means nothing to a reader: where the server sent no name, say what it is.
  return people.find((p) => p.email.toLowerCase() === lower)?.name || (lower.endsWith("@agents.invalid") ? "Agent" : email);
}

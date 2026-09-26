/** A person's display name from a roster, matched case-insensitively on
 *  email; the email itself when there's no match or no name set. */
export function displayNameFor(
  email: string,
  people: Array<{ email: string; name: string | null }> = [],
): string {
  const lower = email.toLowerCase();
  return people.find((p) => p.email.toLowerCase() === lower)?.name || email;
}

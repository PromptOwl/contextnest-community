/**
 * Why a nest name can't be used, or null when it can. Mirrors the server's
 * refusals (src/nests/service.ts — createNest and renameNest share them): the
 * name must survive trimming, it must be something other than markup (the
 * server stores names as plain text and strips tags), and it must leave
 * something behind once slugified. The slug is a-z0-9, so "###" or "!!!"
 * derives an empty one and the nest would have no URL.
 *
 * Client-side so the form can disable its button and say why inline; the server
 * still refuses the same names for callers that skip the UI.
 */
export function nestNameProblem(name: string): string | null {
  if (!name.trim()) return "Name is required";
  // Checked before the slug rule: "<img src=x onerror=alert(1)>" is full of
  // a-z0-9 and would otherwise pass, then come back as "Name cannot be empty"
  // from the server once the tags were stripped.
  const plain = name.replace(/<[^>]*>/g, "").trim();
  if (!plain) {
    return "That's not a valid nest name — it's only HTML markup. Use plain text.";
  }
  if (!/[a-z0-9]/i.test(plain)) {
    return "The URL slug is built from a-z and 0-9, so the name needs at least one of those";
  }
  return null;
}

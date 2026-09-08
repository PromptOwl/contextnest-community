/**
 * Why a nest name can't be used, or null when it can. Mirrors the server's
 * refusals (src/nests/service.ts — createNest and renameNest share them): the
 * name must survive trimming, it must carry no HTML tag (names are stored as
 * plain text), and it must leave something behind once slugified. The slug is
 * a-z0-9, so "###" or "!!!" derives an empty one and the nest would have no
 * URL.
 *
 * Client-side so the form can disable its button and say why inline; the server
 * still refuses the same names for callers that skip the UI.
 */
export function nestNameProblem(name: string): string | null {
  if (!name.trim()) return "Name is required";
  // A tag is refused, not stripped — "Roadmap <2026> plan" is legitimate text
  // and keeps its brackets, while "<img src=x onerror=alert(1)>" is named as
  // the problem here instead of being silently rewritten.
  if (/<\/?[a-zA-Z][^>]*>/.test(name)) {
    return "Nest names are plain text — remove the HTML tags.";
  }
  if (!/[a-z0-9]/i.test(name)) {
    return "The URL slug is built from a-z and 0-9, so the name needs at least one of those";
  }
  return null;
}

/**
 * The form a nest name takes when it is typed back to confirm a destructive
 * action. HTML collapses runs of whitespace, so a name holding one (older nests
 * kept the gap a stripped tag left behind) rendered shorter than it was stored
 * — copying it off the dialog then never matched and the nest could not be
 * deleted (CU-wdqcq01e6u).
 */
export const confirmableName = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Why a nest name can't be used, or null when it can. Mirrors the server's two
 * refusals (src/nests/service.ts — createNest and renameNest share them): the
 * name must survive trimming, and it must leave something behind once
 * slugified. The slug is a-z0-9, so "###" or "!!!" derives an empty one and the
 * nest would have no URL.
 *
 * Client-side so the form can disable its button and say why inline; the server
 * still refuses the same names for callers that skip the UI.
 */
export function nestNameProblem(name: string): string | null {
  if (!name.trim()) return "Name is required";
  if (!/[a-z0-9]/i.test(name)) {
    return "Name must contain at least one letter or number";
  }
  return null;
}

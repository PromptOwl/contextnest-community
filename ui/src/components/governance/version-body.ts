/**
 * Which body the version preview should show for one version.
 *
 * The version list ships `content: ""` on every row — bodies are fetched one at
 * a time from `GET .../versions/:version`. So an empty inline body means "not
 * here", never "this version is empty": treating it as content is what made the
 * preview render "(no content)" over a version whose body had already loaded.
 *
 * `undefined` = still loading (nothing fetched yet), `null` = the server could
 * not reconstruct that version.
 */
export function resolveBody(
  inline: string | undefined,
  fetched: string | null | undefined,
): string | null | undefined {
  return inline ? inline : fetched;
}

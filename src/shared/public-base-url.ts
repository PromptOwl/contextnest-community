/**
 * Shape check for PUBLIC_BASE_URL — the server's own canonical address.
 *
 * This is stricter than "looks like a URL" on purpose. The value is spliced,
 * unescaped, into snippets that other people are told to copy and run:
 *
 * - a `bash` block (`claude mcp add … <url>/mcp`, `codex mcp add --url …`),
 * - quoted strings in `config.toml`, `~/.hermes/config.yaml` and `mcp.json`,
 * - single-backtick markdown code spans in the Connecting-agents panel.
 *
 * Only an admin can set it, but everyone downstream pastes the result into
 * their own terminal — so an unchecked `$(…)`, `;`, `|` or `"` turns "can edit
 * server settings" into code execution on every teammate's machine. It is also
 * the audience a minted MCP ticket is bound to, so a malformed value silently
 * breaks token verification rather than failing loudly.
 *
 * A legitimate base URL needs none of those characters, so refuse them here
 * rather than escaping per destination — there is no escaping scheme that is
 * simultaneously correct for shell, TOML, YAML, JSON and markdown.
 *
 * Returns the reason a value is rejected, or null when it passes. The empty
 * string passes: clearing the field is how the setting is unset.
 */

/** Characters that could break out of a shell word, a quoted string or a code span. */
const UNSAFE = /["'`\\$;|&<>(){}\s]/;

export function publicBaseUrlError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;

  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "Public base URL must be a full http(s) URL, e.g. https://nest.example.com";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return "Public base URL must use http or https, e.g. https://nest.example.com";
  if (!parsed.hostname)
    return "Public base URL must include a hostname, e.g. https://nest.example.com";

  // Checked on the raw value, not the parsed one: URL parsing percent-encodes
  // some of these in the path, which would hide them from this test while they
  // still round-trip into the snippets as typed.
  if (UNSAFE.test(v))
    return "Public base URL must not contain spaces, quotes or shell characters (\" ' ` \\ $ ; | & < > ( ) { }) — it is pasted into terminal commands and config files.";

  return null;
}

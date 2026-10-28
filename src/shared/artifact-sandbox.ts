/**
 * Shared hardening headers for serving artifact HTML on the app origin.
 * Used by BOTH artifact-serving surfaces — the annotations `/hosted` viewer
 * and the node `?format=raw` direct fetch — so the sandbox policy can never
 * drift between them.
 *
 * Artifact bodies are editor/attacker-controlled HTML+JS. Served same-origin
 * without a sandbox, their scripts would ride the viewer's session (httpOnly
 * cookies don't stop same-origin fetch). The strict CSP below prevents that:
 * `sandbox` WITHOUT `allow-same-origin` forces an opaque origin so the
 * document can't touch host cookies/storage; the resource directives then cap
 * what its inline scripts may load or reach — `connect-src 'none'` blocks
 * fetch/XHR/beacon exfiltration, `default-src 'none'` blocks external loads,
 * and only inline script/style + data/blob images are permitted
 * (self-contained decks/dashboards need no network).
 */
export const ARTIFACT_SANDBOX_CSP = [
  "sandbox allow-scripts allow-popups allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The same policy with `allow-popups` removed — for frames that carry nest
 * data (the html blocks of a §1.12 view). Every other directive is kept, so
 * `default-src 'none'` and `connect-src 'none'` still close the network; a
 * popup is one more channel such a frame has no business opening. Derived
 * from ARTIFACT_SANDBOX_CSP so the two can never drift apart.
 */
export const ARTIFACT_SANDBOX_CSP_NO_POPUPS = ARTIFACT_SANDBOX_CSP.replace(
  " allow-popups",
  "",
);

/**
 * Merge a `frame-ancestors` directive into an existing CSP header value.
 *
 * The global clickjacking guard (see app.ts) runs on every response, including
 * artifact ones that already carry ARTIFACT_SANDBOX_CSP. Assigning the header
 * there would drop the sandbox and put attacker-authored artifact HTML back on
 * the session, so the guard merges instead. A handler that set its own
 * frame-ancestors keeps it.
 */
export function mergeFrameAncestors(
  existing: string | null | undefined,
  directive: string,
): string {
  if (!existing) return directive;
  if (/(^|;)\s*frame-ancestors\b/i.test(existing)) return existing;
  return `${existing}; ${directive}`;
}

/**
 * Apply the artifact sandbox trio: strict CSP + nosniff + no referrer.
 * `{ popups: false }` swaps in ARTIFACT_SANDBOX_CSP_NO_POPUPS; called with no
 * options it behaves exactly as it always has.
 */
export function applyArtifactSandboxHeaders(
  c: {
    header: (name: string, value: string) => void;
  },
  opts: { popups?: boolean } = {},
): void {
  c.header(
    "Content-Security-Policy",
    opts.popups === false ? ARTIFACT_SANDBOX_CSP_NO_POPUPS : ARTIFACT_SANDBOX_CSP,
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
}

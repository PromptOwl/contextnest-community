/**
 * Whether a server URL is obviously private — loopback, RFC 1918, link-local,
 * CGNAT/Tailscale, or an internal-only name (.local, .internal, .lan, .corp,
 * .home.arpa, or a bare hostname with no dot). Such a host is unreachable
 * from a hosted connector (claude.ai, Claude Desktop/Cowork connectors,
 * ChatGPT): those connect from the vendor's servers, not from the person's
 * machine, so a VPN on the laptop doesn't help.
 *
 * Mirrored by ui/src/lib/connect.ts `isPrivateHost` (the UI doesn't import
 * server code); test/private-host.test.ts keeps the two in lockstep.
 */
export function isPrivateHost(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // bare intranet name
  if (/\.(local|internal|lan|corp|intranet|home\.arpa)$/.test(host)) return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

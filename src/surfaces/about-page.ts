/**
 * GET /about/surfaces — the member-facing explainer (po-1186 CR3, AC-CR-16).
 *
 * The page the bot links in its one enable notice, for anyone in a channel
 * where Nest listens. Public: no session, no key, nothing nest-specific. It
 * renders the server's own Surfaces settings (quiet window, how long text is
 * held, whether DMs are captured) and the optional organization name and logo
 * an admin set for this server. It never reads a nest, a binding, a channel or
 * a user, so it cannot name one.
 *
 * Plain server-rendered HTML (not the SPA): it has to open for a channel
 * member who has no account here. 404 while Surfaces is off, like every other
 * Surfaces route.
 */
import { Hono } from "hono";
import { config } from "../config.js";
import { surfacesEnabled } from "./flags.js";
import { getSettings } from "./services/settings-service.js";
import { DEFAULT_SETTINGS, type SurfaceSettings } from "./core/settings.js";

export const ABOUT_SURFACES_PATH = "/about/surfaces";

/** The absolute link the bot posts, or null when this server has no public base URL. */
export function aboutSurfacesUrl(): string | null {
  const base = config.PUBLIC_BASE_URL;
  return base ? `${base}${ABOUT_SURFACES_PATH}` : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** What Nest never does, in the words the setup wizard uses. */
export function neverList(s: Pick<SurfaceSettings, "buffer_ttl_hours">): string[] {
  return [
    "Read DMs between people, or channels it isn't in",
    "Import channel history",
    "Post recaps or summaries in the channel",
    "Propose pay, health, performance or personal matters",
    `Keep message text longer than ${s.buffer_ttl_hours} hours`,
  ];
}

export function renderAboutSurfaces(opts: { orgName: string | null; logoUrl: string | null; settings: SurfaceSettings }): string {
  const { orgName, logoUrl, settings: s } = opts;
  const where = orgName ? `some ${esc(orgName)} channels` : "some of your team's channels";
  const dms = s.dm_capture ? ", in direct messages people start with Nest themselves," : "";
  const logo = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="${orgName ? esc(orgName) : "Logo"}">` : "";
  const never = neverList(s)
    .map((t) => `<li>${esc(t)}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>How Nest handles your messages</title>
<style>
:root{--fg:#09090b;--fg2:#3f3f46;--muted:#52525b;--border:#e4e4e7;--primary:hsl(228 73% 29%);--bg:#fff}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:600px;margin:0 auto;padding:48px 16px 64px}
.logo{display:block;max-height:32px;max-width:160px;margin-bottom:24px}
h1{font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin:0 0 12px}
h2{font-size:16px;font-weight:600;margin:28px 0 8px}
p{margin:0 0 12px;color:var(--fg2)}
p b{color:var(--fg)}
ul{margin:0;padding-left:20px;color:var(--fg2)}
li{margin:4px 0}
code{font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f4f4f5;border-radius:4px;padding:1px 5px;color:var(--fg)}
footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--border);font-size:14px;color:var(--muted)}
</style></head>
<body><main>
${logo}<h1>How Nest handles your messages</h1>
<p>Your admin turned on Nest in ${where}. It helps the team remember decisions without anyone writing them up.</p>
<p><b>It reads</b> messages in those channels only${dms ? dms : ","} never DMs between people, and never old history.</p>
<p><b>It waits</b> until a thread has been quiet for ${s.quiet_minutes} minutes. Then it decides if the thread holds a decision or a fact worth keeping. Usually the answer is no, and nothing happens.</p>
<p><b>It keeps</b> nothing unless a named teammate approves a short summary. Raw messages are deleted within ${s.buffer_ttl_hours} hours.</p>
<p><b>It never saves</b> anything about pay, health, performance or personal life.</p>
<p><b>You can</b> say <code>@Nest skip me</code> to keep your messages out, or ask an admin to remove it from a channel.</p>
<h2>It will never</h2>
<ul>${never}</ul>
<footer>This page is the same for everyone. It doesn't know who you are or which channel you came from.</footer>
</main></body></html>`;
}

export const aboutSurfacesRoutes = new Hono();

aboutSurfacesRoutes.get("/", async (c) => {
  if (!surfacesEnabled()) return c.json({ error: "Not found" }, 404);
  const settings = await getSettings().catch(() => ({ ...DEFAULT_SETTINGS }));
  c.header("Cache-Control", "public, max-age=300");
  c.header("X-Robots-Tag", "noindex");
  // Nothing on this page runs script or loads anything but the admin's logo.
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(renderAboutSurfaces({ orgName: config.SURFACES_ORG_NAME ?? null, logoUrl: config.LOGO_URL, settings }));
});

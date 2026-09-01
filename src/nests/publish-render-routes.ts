/**
 * Public render surface for published documents — mounted at top-level `/p`,
 * OUTSIDE the /nests auth chain, so it is reachable with no account.
 *
 *   GET  /p/:slug           → the document, a gate form, or (when comments are
 *                             on) the reader shell that frames the document
 *   GET  /p/:slug/view      → the document itself, always sandboxed
 *   POST /p/:slug/gate      → submit a code, or request a magic link by email
 *   GET  /p/:slug/verify    → consume a magic link → set session cookie → open
 *   POST /p/:slug/comments  → file a comment (JSON), from the shell's modal
 *
 * The published document itself is served under the strict artifact sandbox
 * (opaque origin, no host cookies, no network) — the same policy the /hosted
 * artifact viewer uses. Our own chrome can never live inside it: the sandbox
 * blocks forms and network calls, and a popup opened from it INHERITS those
 * flags. So anything interactive (the gate form, the comment modal) is ordinary
 * HTML on a separate page or on the shell that frames the document.
 */
import { Hono } from "hono";
import MarkdownIt from "markdown-it";
import { normalizeEmail } from "../shared/email.js";
import { isEmailish } from "../config.js";
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { isSecureRequest } from "../auth/sessions.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { readArtifact, createThread } from "../annotations/service.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import * as publish from "./publish-service.js";
import type { PublishRow } from "./publish-service.js";

export const publishRenderRoutes = new Hono();

const SESSION_TTL_SECONDS = 24 * 60 * 60;

// Gate attempts per link per IP. Loose enough that a room full of people
// sharing one NAT can all type the passcode, tight enough that neither
// exhaustive guessing nor bulk mailing is practical.
const GATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };

// Comments are an anonymous write path, so they get their own (tighter) clamp.
const COMMENT_LIMIT = { max: 5, windowMs: 10 * 60_000 };
const COMMENT_MAX_CHARS = 4000;

// Markdown nodes are rendered server-side so a published document reads like the
// editor rather than as raw source. `html: false` keeps inline HTML escaped —
// belt and braces, since the page already runs under the artifact sandbox.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Reader styling for a rendered markdown document: one column, generous
 *  measure, and the same indigo headings the app uses. */
const PROSE_CSS = `
  body{margin:0;background:#fff;color:#1c1917;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:820px;margin:0 auto;padding:48px 24px}
  h1,h2,h3,h4{color:#142a80;line-height:1.25;margin:1.8em 0 .6em}
  h1{font-size:2em;margin-top:0}h2{font-size:1.5em}h3{font-size:1.2em}h4{font-size:1.05em}
  p,ul,ol,blockquote,table{margin:0 0 1.1em}
  ul,ol{padding-left:1.5em}li{margin:.3em 0}
  a{color:#142a80}
  hr{border:0;border-top:1px solid #e7e5e4;margin:2em 0}
  blockquote{border-left:3px solid #d6d3d1;margin-left:0;padding:.2em 0 .2em 1em;color:#57534e}
  code{background:#f5f5f4;border-radius:4px;padding:.15em .35em;font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  pre{background:#f5f5f4;border-radius:9px;padding:14px 16px;overflow-x:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
  th,td{border:1px solid #e7e5e4;padding:8px 10px;text-align:left}
  th{background:#fafaf9}
  img{max-width:100%}
`;

function cookieName(slug: string): string {
  return `cnp_${slug}`;
}

function readCookie(c: any, name: string): string | null {
  const raw = c.req.header("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

function setSessionCookie(c: any, slug: string, token: string): void {
  const parts = [
    `${cookieName(slug)}=${encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=/p/${slug}`,
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(c)) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The viewer overlays: a watermark stamping the viewer's email across the page,
 *  and a print-blank for no-download. Both are deterrents against casual copying,
 *  never enforcement — anything a browser renders can be screenshotted. The
 *  watermark needs an identified viewer, so it is a no-op on public/code gates. */
function overlayMarkup(row: PublishRow, viewerEmail: string | null): string {
  const parts: string[] = [];
  if (row.no_download === 1) {
    parts.push(
      `<style>@media print{html,body{display:none !important}}body{-webkit-user-select:none;user-select:none}</style>`,
    );
  }
  if (row.watermark === 1 && viewerEmail) {
    parts.push(
      `<style>#cn-watermark{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;display:flex;align-items:center;justify-content:center}` +
        `#cn-watermark span{font:700 42px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:rgba(20,42,128,.10);transform:rotate(-24deg);white-space:nowrap}</style>` +
        `<div id="cn-watermark" aria-hidden="true"><span>${esc(viewerEmail)}</span></div>`,
    );
  }
  return parts.join("");
}

/** The document's title, for the reader shell's tab label. Falls back to the
 *  node id rather than failing the page over a label. */
async function publishedTitle(row: PublishRow): Promise<string> {
  try {
    return (await readArtifact(row.nest_id, row.node_id)).title || row.node_id;
  } catch {
    return row.node_id;
  }
}

/** Splice the overlays in just before `</body>` so they sit above the document,
 *  falling back to an append for bodies that ship no closing tag. */
function withOverlays(html: string, extra: string): string {
  if (!extra) return html;
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + extra : html.slice(0, at) + extra + html.slice(at);
}

/** Serve the published document body. HTML/artifact bodies render as-is under
 *  the sandbox; other node types get a minimal readable shell (rich markdown
 *  rendering is a follow-up).
 *
 *  Served through `readArtifact`, the same reader the /hosted viewer uses, so a
 *  public link shows the APPROVED version. Reading the live body here would put
 *  an in-progress edit on the open web the moment it was saved — ungoverned
 *  content, from the surface whose whole premise is governance. It also gives us
 *  readArtifact's fence normalization for free (a fenced artifact body would
 *  otherwise render as literal text). */
async function renderPublished(c: any, row: PublishRow, viewerEmail: string | null) {
  let artifact: Awaited<ReturnType<typeof readArtifact>>;
  try {
    artifact = await readArtifact(row.nest_id, row.node_id);
  } catch {
    // The source node moved or was removed since it was published. Deliberately
    // opaque — a public 404 must not confirm which node ids exist.
    return c.html(unavailablePage(), 404);
  }
  // A null version means readArtifact found no approved snapshot and fell back
  // to the live body. Serving that would put an unapproved draft on the open
  // web, so a document that has never been approved simply has nothing to show.
  if (artifact.version == null) return c.html(unavailablePage(), 404);
  const type = String(artifact.type ?? "document");
  const body = artifact.html ?? "";
  const isHtml = type === "artifact" || /^\s*<(?:!doctype|html)\b/i.test(body);

  await publish.logView(row.id, viewerEmail);
  applyArtifactSandboxHeaders(c);
  const overlays = overlayMarkup(row, viewerEmail);
  if (isHtml) {
    return c.body(withOverlays(body, overlays), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }
  const title = esc(artifact.title || row.node_id);
  // The body almost always opens with its own H1, so only fall back to the
  // node title when it doesn't — otherwise the page shows the heading twice.
  const heading = /^\s*#\s/.test(body) ? "" : `<h1>${title}</h1>`;
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${PROSE_CSS}</style></head><body><main>${heading}${markdown.render(body)}</main>${overlays}</body></html>`;
  return c.body(shell, 200, { "Content-Type": "text/html; charset=utf-8" });
}

/** The gate form (ordinary HTML — NOT sandboxed, so its form can post). */
function gatePage(row: PublishRow, message?: string): string {
  const wantsCode = row.access_mode === "code";
  const field = wantsCode
    ? `<label>Access code<input name="code" type="password" autocomplete="off" required autofocus></label>`
    : `<label>Your email<input name="email" type="email" autocomplete="email" required autofocus></label>`;
  const cta = wantsCode ? "Unlock" : "Send me a link";
  const note = wantsCode
    ? "This document is protected by a passcode."
    : "Enter your email and we'll send you a one-time link to open it.";
  const err = message
    ? `<p class="err">${esc(message)}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Protected document</title><style>
    :root{--indigo:#142a80;--owl:#FF6500}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:380px;width:calc(100% - 32px)}
    h1{font-size:20px;color:var(--indigo);margin:0 0 6px}
    p{color:#78716c;margin:0 0 18px;font-size:14px}
    label{display:block;font-size:13px;font-weight:600;color:#44403c;margin-bottom:16px}
    input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box}
    button{width:100%;background:var(--indigo);color:#fff;font-weight:700;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
    .err{color:#be123c;font-weight:600}
    .brand{font-size:12px;color:#a8a29e;margin:18px 0 0;text-align:center}
  </style></head><body><form class="card" method="POST" action="/p/${esc(row.slug)}/gate">
    <h1>Protected document</h1><p>${esc(note)}</p>${err}${field}
    <button type="submit">${cta}</button>
    <p class="brand">Secured by PromptOwl · ContextNest</p>
  </form></body></html>`;
}

/** What a reader sees when a link no longer works — revoked, expired, or never
 *  real. Deliberately ONE message for all three: saying "revoked" rather than
 *  "expired" (or "no such link") would confirm which slugs exist. A person
 *  holding a dead link needs to know to ask for a new one, not which of the
 *  three it was. */
function unavailablePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link unavailable</title><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:420px;width:calc(100% - 32px);text-align:center}
    h1{font-size:20px;color:#142a80;margin:0 0 8px}
    p{color:#78716c;margin:0;font-size:14px}
    .brand{font-size:12px;color:#a8a29e;margin:18px 0 0}
  </style></head><body><div class="card">
    <h1>This link is no longer available</h1>
    <p>It may have been revoked by its owner, or it may have expired. Ask whoever shared it with you for a new link.</p>
    <p class="brand">Secured by PromptOwl · ContextNest</p>
  </div></body></html>`;
}

function sentPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your email</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:380px;text-align:center}h1{font-size:20px;color:#142a80;margin:0 0 6px}p{color:#78716c;margin:0;font-size:14px}</style></head><body><div class="card"><h1>Check your email</h1><p>If your address has access, a one-time link to open this document is on its way.</p></div></body></html>`;
}

/** The reader shell for a commentable publish: the document itself in a
 *  full-bleed same-origin iframe, with our comment button and modal alongside
 *  it.
 *
 *  The controls cannot live inside the document. That document is served under
 *  the artifact sandbox (opaque origin, `form-action 'none'`, `connect-src
 *  'none'`), and a popup opened from it inherits those sandbox flags — which is
 *  why the old separate comment page rendered but could never submit. Framing
 *  the document keeps its sandbox intact and puts the comment UI on a page we
 *  control and trust. */
function readerShell(row: PublishRow, title: string, viewerEmail: string | null): string {
  // A gated viewer is already identified; anyone else names themselves.
  const emailField = viewerEmail
    ? `<p class="who">Commenting as <strong>${esc(viewerEmail)}</strong></p>`
    : `<label>Your email<input id="cn-email" type="email" autocomplete="email" required></label>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
    html,body{margin:0;height:100%}
    #cn-frame{border:0;width:100%;height:100%;display:block}
    #cn-open{position:fixed;right:18px;bottom:18px;z-index:20;background:#142a80;color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:11px 16px;border:0;border-radius:9999px;cursor:pointer;box-shadow:0 4px 14px rgba(20,42,128,.32)}
    #cn-back{position:fixed;inset:0;z-index:30;background:rgba(28,25,23,.45);display:none;place-items:center}
    #cn-back[data-open]{display:grid}
    .card{background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(20,42,128,.22);padding:28px 30px;width:min(460px,calc(100% - 32px));font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1917;box-sizing:border-box}
    .card h2{font-size:20px;color:#142a80;margin:0 0 6px}
    .card p{color:#78716c;margin:0 0 18px;font-size:14px}
    .who strong{color:#44403c}
    label{display:block;font-size:13px;font-weight:600;color:#44403c;margin-bottom:16px}
    input,textarea{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box}
    textarea{min-height:130px;resize:vertical}
    .row{display:flex;gap:10px}
    button{flex:1;background:#142a80;color:#fff;font-weight:700;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
    button.ghost{background:#f5f5f4;color:#44403c}
    button[disabled]{opacity:.6;cursor:default}
    .msg{font-weight:600;margin:0 0 14px;font-size:14px}
    .msg.err{color:#be123c}.msg.ok{color:#15803d}
  </style></head><body>
    <iframe id="cn-frame" src="/p/${esc(row.slug)}/view" title="${esc(title)}"></iframe>
    <button id="cn-open" type="button">Leave a comment</button>
    <div id="cn-back"><div class="card" role="dialog" aria-modal="true" aria-label="Leave a comment">
      <h2>Leave a comment</h2>
      <p>Your comment goes to this document's stewards for review — it is not posted publicly.</p>
      <p class="msg" id="cn-msg" hidden></p>
      ${emailField}
      <label>Comment<textarea id="cn-body" maxlength="${COMMENT_MAX_CHARS}" required></textarea></label>
      <div class="row">
        <button type="button" class="ghost" id="cn-cancel">Cancel</button>
        <button type="button" id="cn-send">Send comment</button>
      </div>
    </div></div>
  <script>
  (function () {
    var back = document.getElementById("cn-back");
    var msg = document.getElementById("cn-msg");
    var send = document.getElementById("cn-send");
    var bodyEl = document.getElementById("cn-body");
    var emailEl = document.getElementById("cn-email");
    function show(text, ok) {
      msg.textContent = text;
      msg.className = "msg " + (ok ? "ok" : "err");
      msg.hidden = false;
    }
    function open() { msg.hidden = true; back.setAttribute("data-open", ""); (emailEl || bodyEl).focus(); }
    function close() { back.removeAttribute("data-open"); }
    document.getElementById("cn-open").addEventListener("click", open);
    document.getElementById("cn-cancel").addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    send.addEventListener("click", function () {
      var payload = { body: bodyEl.value };
      if (emailEl) payload.email = emailEl.value;
      send.disabled = true;
      fetch("/p/${esc(row.slug)}/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { show(res.d.error || "Could not send that comment.", false); return; }
          bodyEl.value = "";
          show("Thanks — your comment is with the stewards.", true);
          setTimeout(close, 1600);
        })
        .catch(function () { show("Could not reach the server.", false); })
        .then(function () { send.disabled = false; });
    });
  })();
  </script></body></html>`;
}

/** CSP for the reader shell. The shell is our own markup, so it is NOT
 *  sandboxed — but it still may not load anything external, and it may only
 *  frame and talk to this origin. The framed document keeps its own strict
 *  artifact sandbox. */
const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "connect-src 'self'",
].join("; ");

/** Who is allowed to see this publish right now, and who they are. `null` means
 *  the gate has not been passed. A public viewer is allowed but anonymous. */
async function resolveViewer(
  c: any,
  row: PublishRow,
): Promise<{ email: string | null } | null> {
  if (row.access_mode === "public") return { email: null };
  // A live session carries the viewer it was opened for, so an email/invite view
  // is logged against the person who opened it rather than as an anonymous hit.
  const token = readCookie(c, cookieName(row.slug));
  return token ? await publish.verifySession(row.id, token) : null;
}

// GET /p/:slug — the document, or the gate, or (when comments are on) the
// reader shell that frames the document alongside the comment controls.
publishRenderRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);

  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(gatePage(row));
  if (row.comments_enabled !== 1) return renderPublished(c, row, viewer.email);

  // The shell frames /view, which is what logs the view and applies the
  // sandbox — nothing is logged twice.
  const title = await publishedTitle(row);
  c.header("Content-Security-Policy", SHELL_CSP);
  c.header("Referrer-Policy", "no-referrer");
  return c.html(readerShell(row, title, viewer.email));
});

// GET /p/:slug/view — the document itself, always sandboxed. Framed by the
// shell above, and gated independently: being the frame source is not
// authorization.
publishRenderRoutes.get("/:slug/view", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(unavailablePage(), 404);
  return renderPublished(c, row, viewer.email);
});

// POST /p/:slug/comments — file a comment against the document.
publishRenderRoutes.post("/:slug/comments", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row) || row.comments_enabled !== 1) {
    return c.json({ error: "Not found" }, 404);
  }
  // Posting requires clearing the document's own gate, so an unauthenticated
  // writer can never appear on a gated document.
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.json({ error: "Not found" }, 404);

  if (!tryConsume(`publish-comment:${slug}:${clientIp(c)}`, COMMENT_LIMIT)) {
    return c.json({ error: "Too many comments. Try again in a few minutes." }, 429);
  }

  const input = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    body?: string;
  };
  // The ticket requires an identifying email on every comment: take the gated
  // viewer's when we have one, otherwise the address they typed.
  const email = viewer.email ?? normalizeEmail(String(input.email ?? ""));
  if (!isEmailish(email)) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }
  const body = String(input.body ?? "").trim().slice(0, COMMENT_MAX_CHARS);
  if (!body) {
    return c.json({ error: "Write a comment first." }, 400);
  }

  // Lands as an unanchored annotation thread — the same list the document's
  // Comments panel already renders, so a steward actually sees it. A public
  // reader can never open-write onto the document itself.
  await createThread(row.nest_id, row.node_id, { body, anchor: null }, email);
  return c.json({ ok: true });
});

// POST /p/:slug/gate — submit code (unlock now) or email (send magic link).
publishRenderRoutes.post("/:slug/gate", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);

  // Anonymous endpoint: without a clamp, the code gate is an unlimited guessing
  // oracle against a human-chosen passcode, and the email branch is an open
  // relay that mails any address an attacker supplies.
  if (!tryConsume(`publish-gate:${slug}:${clientIp(c)}`, GATE_LIMIT)) {
    return c.html(gatePage(row, "Too many attempts. Try again in a few minutes."), 429);
  }

  // A public link has no gate to pass, so a POST here is either a stale form or
  // someone probing for the email branch below. Never fall through to it.
  if (row.access_mode === "public") return c.redirect(`/p/${slug}`);

  const form = await c.req.parseBody();

  if (row.access_mode === "code") {
    if (!(await publish.verifyCode(row, String(form.code ?? "")))) {
      return c.html(gatePage(row, "That code is not correct."), 401);
    }
    setSessionCookie(c, slug, await publish.createSession(row.id, null));
    return c.redirect(`/p/${slug}`);
  }

  const email = normalizeEmail(String(form.email ?? ""));
  if (!isEmailish(email)) {
    return c.html(gatePage(row, "Enter a valid email address."), 400);
  }
  // Invite mode: only allow-listed addresses get a link. Respond identically
  // either way so the form can't be used to probe the allow-list.
  if (row.access_mode === "invite" && !(await publish.isAllowlisted(row.id, email))) {
    return c.html(sentPage());
  }
  const linkToken = await publish.mintMagicLink(row.id, email);
  const link = `${requestBaseUrl(c.req.url)}/p/${slug}/verify?token=${linkToken}`;
  void sendEmailToRecipient(email, {
    status: "shared",
    docTitle: "A document has been shared with you",
    path: "PromptOwl · ContextNest",
    link,
  });
  return c.html(sentPage());
});

// GET /p/:slug/verify?token= — consume the magic link, open a session, redirect.
publishRenderRoutes.get("/:slug/verify", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);
  const email = await publish.consumeMagicLink(row.id, c.req.query("token") ?? "");
  if (!email) {
    return c.html(gatePage(row, "That link is invalid or has expired. Request a new one."), 401);
  }
  setSessionCookie(c, slug, await publish.createSession(row.id, email));
  return c.redirect(`/p/${slug}`);
});

/**
 * Public render surface for published documents — mounted at top-level `/p`,
 * OUTSIDE the /nests auth chain, so it is reachable with no account.
 *
 *   GET  /p/:slug          → the page (public) or a gate form (email/code/invite)
 *   POST /p/:slug/gate      → submit a code, or request a magic link by email
 *   GET  /p/:slug/verify    → consume a magic link → set session cookie → open
 *
 * The published document itself is served under the strict artifact sandbox
 * (opaque origin, no host cookies, no network) — the same policy the /hosted
 * artifact viewer uses. The GATE page is ordinary HTML (it needs a same-origin
 * form post, which the sandbox's `form-action 'none'` would block), and never
 * carries document content.
 */
import { Hono } from "hono";
import { NotFoundError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { isEmailish } from "../config.js";
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { isSecureRequest } from "../auth/sessions.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { readArtifact } from "../annotations/service.js";
import { createComment } from "../governance/comment-service.js";
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
  if (row.comments_enabled === 1) {
    // Opens in a new tab: the sandbox allows popups but not top-level
    // navigation, and the form itself cannot live inside the sandboxed body.
    parts.push(
      `<style>#cn-comment{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#142a80;color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:11px 16px;border-radius:9999px;text-decoration:none;box-shadow:0 4px 14px rgba(20,42,128,.32)}</style>` +
        `<a id="cn-comment" href="/p/${esc(row.slug)}/comment" target="_blank" rel="noopener">Leave a comment</a>`,
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
    throw new NotFoundError("Not found");
  }
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
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;background:#fff;color:#1c1917;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:820px;margin:0 auto;padding:48px 24px}h1{color:#142a80}pre{white-space:pre-wrap;word-wrap:break-word}</style></head><body><main><h1>${title}</h1><pre>${esc(body)}</pre></main>${overlays}</body></html>`;
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

function sentPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your email</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:380px;text-align:center}h1{font-size:20px;color:#142a80;margin:0 0 6px}p{color:#78716c;margin:0;font-size:14px}</style></head><body><div class="card"><h1>Check your email</h1><p>If your address has access, a one-time link to open this document is on its way.</p></div></body></html>`;
}

/** The comment form. Its own page, NOT part of the document: the artifact
 *  sandbox sets `form-action 'none'`, so a form rendered inside the published
 *  body could never post. The document links out to here instead. */
function commentPage(row: PublishRow, viewerEmail: string | null, message?: string): string {
  // An identified viewer (email/invite gate) is already known, so don't ask
  // again — a passcode or public viewer has to name themselves.
  const who = viewerEmail
    ? `<p class="who">Commenting as <strong>${esc(viewerEmail)}</strong></p>`
    : `<label>Your email<input name="email" type="email" autocomplete="email" required></label>`;
  const err = message ? `<p class="err">${esc(message)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Leave a comment</title><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:460px;width:calc(100% - 32px)}
    h1{font-size:20px;color:#142a80;margin:0 0 6px}
    p{color:#78716c;margin:0 0 18px;font-size:14px}
    .who strong{color:#44403c}
    label{display:block;font-size:13px;font-weight:600;color:#44403c;margin-bottom:16px}
    input,textarea{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box}
    textarea{min-height:130px;resize:vertical}
    button{width:100%;background:#142a80;color:#fff;font-weight:700;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
    .err{color:#be123c;font-weight:600}
    .brand{font-size:12px;color:#a8a29e;margin:18px 0 0;text-align:center}
  </style></head><body><form class="card" method="POST" action="/p/${esc(row.slug)}/comments">
    <h1>Leave a comment</h1><p>Your comment goes to this document's stewards for review — it is not posted publicly.</p>${err}${who}
    <label>Comment<textarea name="body" maxlength="${COMMENT_MAX_CHARS}" required autofocus></textarea></label>
    <button type="submit">Send comment</button>
    <p class="brand">Secured by PromptOwl · ContextNest</p>
  </form></body></html>`;
}

function commentThanksPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comment sent</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:400px;text-align:center}h1{font-size:20px;color:#142a80;margin:0 0 6px}p{color:#78716c;margin:0;font-size:14px}</style></head><body><div class="card"><h1>Thanks — comment sent</h1><p>A steward will see it alongside the document. You can close this tab.</p></div></body></html>`;
}

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

// GET /p/:slug — render, or present the gate for a protected publish.
publishRenderRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) throw new NotFoundError("Not found");

  const viewer = await resolveViewer(c, row);
  if (viewer) return renderPublished(c, row, viewer.email);
  return c.html(gatePage(row));
});

// GET /p/:slug/comment — the comment form, for a viewer already past the gate.
publishRenderRoutes.get("/:slug/comment", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row) || row.comments_enabled !== 1) {
    throw new NotFoundError("Not found");
  }
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(gatePage(row));
  return c.html(commentPage(row, viewer.email));
});

// POST /p/:slug/comments — file a comment against the document.
publishRenderRoutes.post("/:slug/comments", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row) || row.comments_enabled !== 1) {
    throw new NotFoundError("Not found");
  }
  // Reaching the comment form requires clearing the document's own gate, so an
  // unauthenticated writer can never appear on a gated document.
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(gatePage(row));

  if (!tryConsume(`publish-comment:${slug}:${clientIp(c)}`, COMMENT_LIMIT)) {
    return c.html(
      commentPage(row, viewer.email, "Too many comments. Try again in a few minutes."),
      429,
    );
  }

  const form = await c.req.parseBody();
  // The ticket requires an identifying email on every comment: take the gated
  // viewer's when we have one, otherwise the address they typed.
  const email = viewer.email ?? normalizeEmail(String(form.email ?? ""));
  if (!isEmailish(email)) {
    return c.html(commentPage(row, viewer.email, "Enter a valid email address."), 400);
  }
  const body = String(form.body ?? "").trim().slice(0, COMMENT_MAX_CHARS);
  if (!body) {
    return c.html(commentPage(row, viewer.email, "Write a comment first."), 400);
  }

  // Lands as an ordinary open comment on the node — the same queue stewards
  // already work, so a public reader can never open-write onto the document.
  await createComment({
    nestId: row.nest_id,
    nodeId: row.node_id,
    author: email,
    body,
  });
  return c.html(commentThanksPage());
});

// POST /p/:slug/gate — submit code (unlock now) or email (send magic link).
publishRenderRoutes.post("/:slug/gate", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) throw new NotFoundError("Not found");

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
  if (!publish.isLivePublish(row)) throw new NotFoundError("Not found");
  const email = await publish.consumeMagicLink(row.id, c.req.query("token") ?? "");
  if (!email) {
    return c.html(gatePage(row, "That link is invalid or has expired. Request a new one."), 401);
  }
  setSessionCookie(c, slug, await publish.createSession(row.id, email));
  return c.redirect(`/p/${slug}`);
});

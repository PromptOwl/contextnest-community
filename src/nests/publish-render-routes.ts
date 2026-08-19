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
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { isSecureRequest } from "../auth/sessions.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { getNodeForCaller } from "../nodes/service.js";
import * as publish from "./publish-service.js";
import type { PublishRow } from "./publish-service.js";

export const publishRenderRoutes = new Hono();

const SESSION_TTL_SECONDS = 24 * 60 * 60;

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

/** Serve the published document body. HTML/artifact bodies render as-is under
 *  the sandbox; other node types get a minimal readable shell (rich markdown
 *  rendering is a follow-up). */
async function renderPublished(c: any, row: PublishRow, viewerEmail: string | null) {
  const creatorEmail = await resolveCallerEmail(row.created_by);
  let node: Awaited<ReturnType<typeof getNodeForCaller>>;
  try {
    node = await getNodeForCaller(row.nest_id, { id: row.node_id }, row.created_by, creatorEmail);
  } catch {
    // The source node moved or was removed since it was published.
    throw new NotFoundError("Not found");
  }
  const type = String(node.frontmatter?.type ?? "document");
  const body = node.body ?? "";
  const isHtml = type === "artifact" || /^\s*<(?:!doctype|html)\b/i.test(body);

  await publish.logView(row.id, viewerEmail);
  applyArtifactSandboxHeaders(c);
  if (isHtml) {
    return c.body(body, 200, { "Content-Type": "text/html; charset=utf-8" });
  }
  const title = esc(String(node.frontmatter?.title ?? row.node_id));
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;background:#fff;color:#1c1917;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:820px;margin:0 auto;padding:48px 24px}h1{color:#142a80}pre{white-space:pre-wrap;word-wrap:break-word}</style></head><body><main><h1>${title}</h1><pre>${esc(body)}</pre></main></body></html>`;
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

// GET /p/:slug — render, or present the gate for a protected publish.
publishRenderRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) throw new NotFoundError("Not found");

  if (row.access_mode === "public") {
    return renderPublished(c, row, null);
  }
  const token = readCookie(c, cookieName(slug));
  if (token && (await publish.verifySession(row.id, token))) {
    return renderPublished(c, row, null);
  }
  return c.html(gatePage(row));
});

// POST /p/:slug/gate — submit code (unlock now) or email (send magic link).
publishRenderRoutes.post("/:slug/gate", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) throw new NotFoundError("Not found");
  const form = await c.req.parseBody();

  if (row.access_mode === "code") {
    if (!publish.verifyCode(row, String(form.code ?? ""))) {
      return c.html(gatePage(row, "That code is not correct."), 401);
    }
    setSessionCookie(c, slug, await publish.createSession(row.id, null));
    return c.redirect(`/p/${slug}`);
  }

  const email = normalizeEmail(String(form.email ?? ""));
  if (!email) return c.html(gatePage(row, "Enter a valid email address."), 400);
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

/**
 * Publish — gated public hosting of a single document at /p/<slug>.
 *
 * Covers the security-critical properties: only an owner/admin can publish;
 * a public link serves the document with no auth; a code-gated link shows a
 * gate and refuses the wrong code but opens on the right one; a revoked link
 * stops working; and every served view is logged for the owner.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// Capture outbound mail (invites, magic links) instead of sending it. Hoisted so
// the array exists when the mock factory below runs.
const { mailed } = vi.hoisted(() => ({
  mailed: [] as Array<{ to: string; link?: string }>,
}));
vi.mock("../src/notify/email.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sendEmailToRecipient: async (to: any, details: any) => {
      mailed.push({ to: String(to), link: details?.link });
    },
  };
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let reviewer: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  // Owner is the server admin so it can sync a steward roster below.
  app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Showcase" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Deck One", content: "# hello world deck" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("publish management", () => {
  it("owner publishes a document as a public link", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.publish.access_mode).toBe("public");
    expect(res.data.publish.slug).toBeTruthy();
    expect(res.data.link).toContain(`/p/${res.data.publish.slug}`);
  });

  it("a non-admin cannot publish", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      outsider.apiKey,
    );
    expect([403, 404]).toContain(res.status);
  });

  it("rejects an unsafe node id", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "../other/secret", access_mode: "public" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });
});

describe("public render", () => {
  it("serves the document at /p/<slug> with no auth", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const res = await app.request(`/p/${slug}`); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("hello world deck");
  });

  it("404s an unknown slug", async () => {
    const res = await app.request("/p/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("logs a view the owner can see", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const id = created.data.publish.id;
    const slug = created.data.publish.slug;
    await app.request(`/p/${slug}`);
    const views = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/publications/${id}/views`,
      undefined,
      owner.apiKey,
    );
    expect(views.status).toBe(200);
    expect(views.data.count).toBeGreaterThanOrEqual(1);
  });
});

describe("code gate", () => {
  it("shows a gate, refuses a wrong code, and opens on the right one", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "code", code: "swordfish" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;

    // Bare GET → the gate form, not the content.
    const gate = await app.request(`/p/${slug}`);
    expect(gate.status).toBe(200);
    const gateHtml = await gate.text();
    expect(gateHtml).toContain('name="code"');
    expect(gateHtml).not.toContain("hello world deck");

    // Wrong code → 401.
    const bad = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=wrong",
    });
    expect(bad.status).toBe(401);

    // Right code → redirect + a scoped session cookie.
    const good = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=swordfish",
    });
    expect([302, 303]).toContain(good.status);
    const cookie = good.headers.get("set-cookie") || "";
    expect(cookie).toContain(`cnp_${slug}=`);

    // Replaying the cookie unlocks the content.
    const opened = await app.request(`/p/${slug}`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("hello world deck");
  });
});

describe("email gate", () => {
  it("asks for an email instead of serving content", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "email" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const gate = await app.request(`/p/${slug}`);
    const html = await gate.text();
    expect(html).toContain('name="email"');
    expect(html).not.toContain("hello world deck");
  });

  // The whole point of an email gate is knowing WHO opened the document, so the
  // magic-link round trip has to carry the address all the way into the view log
  // and the watermark — not just past the gate.
  it("a magic link opens the doc, watermarks it, and logs the viewer's email", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "email", watermark: true },
      owner.apiKey,
    );
    const { id, slug } = created.data.publish;
    expect(created.data.publish.watermark).toBe(true);

    const { mintMagicLink } = await import("../src/nests/publish-service.js");
    const token = await mintMagicLink(id, "viewer@acme.com");

    const verify = await app.request(`/p/${slug}/verify?token=${token}`);
    expect([302, 303]).toContain(verify.status);
    const cookie = (verify.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toContain(`cnp_${slug}=`);

    const opened = await app.request(`/p/${slug}`, { headers: { Cookie: cookie } });
    expect(opened.status).toBe(200);
    const html = await opened.text();
    expect(html).toContain("hello world deck");
    expect(html).toContain("viewer@acme.com");

    const views = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/publications/${id}/views`,
      undefined,
      owner.apiKey,
    );
    expect(views.data.views.some((v: any) => v.email === "viewer@acme.com")).toBe(true);
  });

  it("burns the magic link after one use", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "email" },
      owner.apiKey,
    );
    const { id, slug } = created.data.publish;
    const { mintMagicLink } = await import("../src/nests/publish-service.js");
    const token = await mintMagicLink(id, "viewer@acme.com");

    const first = await app.request(`/p/${slug}/verify?token=${token}`);
    expect([302, 303]).toContain(first.status);
    const replay = await app.request(`/p/${slug}/verify?token=${token}`);
    expect(replay.status).toBe(401);
  });
});

describe("viewer overlays", () => {
  it("blanks the page for print when no_download is set, and omits it otherwise", async () => {
    const guarded = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public", no_download: true },
      owner.apiKey,
    );
    expect(guarded.data.publish.no_download).toBe(true);
    const guardedHtml = await (await app.request(`/p/${guarded.data.publish.slug}`)).text();
    expect(guardedHtml).toContain("@media print");

    const plain = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const plainHtml = await (await app.request(`/p/${plain.data.publish.slug}`)).text();
    expect(plainHtml).not.toContain("@media print");
  });

  // A shared passcode identifies nobody, so there is no address to stamp.
  it("does not watermark a viewer it cannot identify", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public", watermark: true },
      owner.apiKey,
    );
    const html = await (await app.request(`/p/${created.data.publish.slug}`)).text();
    expect(html).not.toContain("cn-watermark");
  });
});

describe("governed content", () => {
  // A public link is a governance surface: it must show what was APPROVED, not
  // whatever happens to be saved right now. Needs a nest with a reviewer on the
  // roster — a nest with no stewards auto-publishes every edit, so there is no
  // unapproved state to leak in the first place.
  it("serves the approved version, never an unapproved edit", async () => {
    const gv = await jsonRequest(app, "POST", "/nests", { name: "Governed Vault" }, owner.apiKey);
    const gNest = gv.data.nest.id;
    const nestPath = join(env.dataDir, "nests", gNest);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1\nnest:\n  - email: reviewer@acme.com, role: reviewer, can_approve: true\n`,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/collaborators`,
      { email: "reviewer@acme.com", permission: "write" },
      owner.apiKey,
    );
    const sync = await jsonRequest(app, "POST", `/nests/${gNest}/stewards/sync`, {}, owner.apiKey);
    expect(sync.data.synced).toBeGreaterThan(0);

    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes`,
      { title: "Governed Deck", content: "approved content here" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes/nodes/governed-deck/submit-review`,
      { note: "please review" },
      owner.apiKey,
    );
    const approved = await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes/nodes/governed-deck/approve`,
      { note: "ship it" },
      reviewer.apiKey,
    );
    expect(approved.status).toBe(200);

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/publications`,
      { node_id: "nodes/governed-deck", access_mode: "public" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    expect(await (await app.request(`/p/${slug}`)).text()).toContain("approved content here");

    // Edit and do NOT approve — the live link must not move.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${gNest}/nodes/nodes/governed-deck`,
      { content: "unapproved draft leak" },
      owner.apiKey,
    );
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).toContain("approved content here");
    expect(html).not.toContain("unapproved draft leak");

    // A document that has never been approved has no snapshot to publish, so
    // the link must 404 rather than fall back to serving the draft.
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes`,
      { title: "Never Approved", content: "draft nobody signed off" },
      owner.apiKey,
    );
    const draft = await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/publications`,
      { node_id: "nodes/never-approved", access_mode: "public" },
      owner.apiKey,
    );
    const draftSlug = draft.data.publish.slug;
    const draftRes = await app.request(`/p/${draftSlug}`);
    expect(draftRes.status).toBe(404);
    expect(await draftRes.text()).not.toContain("draft nobody signed off");

    // ...and the 404 is the approval gate, not a bad slug: approve it and the
    // very same link starts serving.
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes/nodes/never-approved/submit-review`,
      { note: "please review" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes/nodes/never-approved/approve`,
      { note: "ship it" },
      reviewer.apiKey,
    );
    const live = await app.request(`/p/${draftSlug}`);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("draft nobody signed off");
  });
});

describe("gate abuse limits", () => {
  it("clamps repeated passcode guesses", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "code", code: "correct-horse" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const guess = () =>
      app.request(`/p/${slug}/gate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "code=nope",
      });

    let sawLimit = false;
    for (let i = 0; i < 15; i++) {
      if ((await guess()).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  // A public link has no gate, so the POST must never reach the mail branch —
  // otherwise every public link doubles as an open relay.
  it("does not treat a public link's gate as a mail endpoint", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const res = await app.request(`/p/${created.data.publish.slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=stranger%40elsewhere.test",
    });
    expect([302, 303]).toContain(res.status);
    expect(await res.text()).not.toContain("Check your email");
  });
});

describe("invite allowlist", () => {
  it("enforces the allowlist and mails the invitees their link", async () => {
    const from = mailed.length;
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      {
        node_id: "nodes/deck-one",
        access_mode: "invite",
        allowlist: ["guest@partner.test", "second@partner.test"],
      },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;

    const invites = mailed.slice(from);
    expect(invites.map((s) => s.to).sort()).toEqual([
      "guest@partner.test",
      "second@partner.test",
    ]);
    expect(invites[0].link).toContain(`/p/${slug}`);

    // An address that isn't on the list gets the same answer as one that is, so
    // the form can't be used to enumerate who was invited...
    const stranger = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=nobody%40elsewhere.test",
    });
    expect(await stranger.text()).toContain("Check your email");
    // ...but no link is ever minted or mailed for them.
    expect(mailed.some((s) => s.to === "nobody@elsewhere.test")).toBe(false);

    // An invited address does get one.
    const invited = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=guest%40partner.test",
    });
    expect(await invited.text()).toContain("Check your email");
    expect(mailed.filter((s) => s.to === "guest@partner.test").length).toBe(2);
  });
});

describe("markdown rendering", () => {
  it("renders a markdown document as HTML, not raw source", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Rendered Doc",
        content:
          "# Rendered Doc\n\n**Prepared for:** someone\n\n## Summary\n\n- first point\n- second point\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
      },
      owner.apiKey,
    );
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/rendered-doc", access_mode: "public" },
      owner.apiKey,
    );
    const html = await (await app.request(`/p/${created.data.publish.slug}`)).text();

    expect(html).toContain("<h1>Rendered Doc</h1>");
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<strong>Prepared for:</strong>");
    expect(html).toContain("<li>first point</li>");
    expect(html).toContain("<table>");
    // The raw markers themselves must be gone — that was the bug.
    expect(html).not.toContain("## Summary");
    expect(html).not.toContain("**Prepared for:**");
    // Title comes from the body's own H1; don't print it twice.
    expect(html.match(/<h1>Rendered Doc<\/h1>/g)?.length).toBe(1);
  });
});

describe("comments", () => {
  it("is closed when the publish did not enable comments", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).not.toContain("Leave a comment");
    // No shell either — a publish without comments is served directly.
    expect(html).not.toContain("cn-frame");
    const post = await app.request(`/p/${slug}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.test", body: "hi" }),
    });
    expect(post.status).toBe(404);
  });

  // "Never ungoverned open-write": a public comment becomes an ordinary comment
  // on the node for stewards to work, not content on the published page.
  it("routes an identified comment to the document's steward queue", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public", comments_enabled: true },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    // The shell carries the comment control and frames the document; the
    // document itself is still served sandboxed, from /view.
    const shell = await (await app.request(`/p/${slug}`)).text();
    expect(shell).toContain("Leave a comment");
    expect(shell).toContain(`src="/p/${slug}/view"`);
    expect(shell).not.toContain("hello world deck");

    // The modal is driven by inline JS that no request can exercise, so at
    // least prove it parses — a syntax slip there breaks commenting silently.
    const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();

    const framed = await app.request(`/p/${slug}/view`);
    expect(framed.status).toBe(200);
    expect(framed.headers.get("content-security-policy")).toContain("sandbox");
    expect(await framed.text()).toContain("hello world deck");

    const sent = await app.request(`/p/${slug}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "reader@outside.test",
        body: "Slide 4 has a typo",
      }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true });

    // Lands in the document's Comments panel (annotation threads), which is
    // where a steward actually looks — not a table nothing renders.
    const threads = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/deck-one/annotations`,
      undefined,
      owner.apiKey,
    );
    expect(threads.status).toBe(200);
    const mine = threads.data.threads.find((t: any) =>
      t.comments.some((x: any) => x.body === "Slide 4 has a typo"),
    );
    expect(mine).toBeDefined();
    expect(mine.comments[0].author).toBe("reader@outside.test");
  });

  it("refuses an unidentified comment", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public", comments_enabled: true },
      owner.apiKey,
    );
    const res = await app.request(`/p/${created.data.publish.slug}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", body: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("does not let an ungated stranger comment on a gated document", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      {
        node_id: "nodes/deck-one",
        access_mode: "code",
        code: "swordfish",
        comments_enabled: true,
      },
      owner.apiKey,
    );
    const slug = created.data.publish.slug;
    const res = await app.request(`/p/${slug}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "stranger@outside.test", body: "let me in" }),
    });
    // Refused outright — no gate cleared, no comment.
    expect(res.status).toBe(404);
    // ...and the document behind it stays shut too.
    expect((await app.request(`/p/${slug}/view`)).status).toBe(404);
    const threads = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/deck-one/annotations`,
      undefined,
      owner.apiKey,
    );
    expect(
      threads.data.threads.some((t: any) =>
        t.comments.some((x: any) => x.body === "let me in"),
      ),
    ).toBe(false);
  });
});

describe("revoke", () => {
  it("stops serving a revoked link", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publications`,
      { node_id: "nodes/deck-one", access_mode: "public" },
      owner.apiKey,
    );
    const { id, slug } = created.data.publish;
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/publications/${id}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
    const res = await app.request(`/p/${slug}`);
    expect(res.status).toBe(404);
  });
});

/**
 * Comment mentions (CU-wdqcq01rxw) — tagging someone in a comment reaches them.
 *
 * The document-body path (nodes/service.ts → notifyMentions) is covered in
 * mentions.test.ts. This suite covers the three comment write paths, all of
 * which were silent: the annotation thread + its replies (what the UI's
 * comments panel posts) and the standalone governance comment (the REST/MCP
 * path). Commenting is a READ-tier action, so a read-only reviewer mentioning
 * someone has to notify too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { MAX_MENTION_RECIPIENTS } from "../src/shared/mentions.js";

describe("comment mentions", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let editor: { apiKey: string; email: string };
  let reviewer: { apiKey: string; email: string };
  let nestId: string;

  const mentions = async (caller: { apiKey: string }) => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/me/notifications",
      undefined,
      caller.apiKey,
    );
    return (
      data.notifications as Array<{
        kind: string;
        message: string;
        node_id: string | null;
      }>
    ).filter((n) => n.kind === "mention");
  };

  /** Open a comment thread on a node. */
  const comment = async (
    caller: { apiKey: string },
    nodeId: string,
    body: string,
  ) =>
    jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/annotations`,
      { body },
      caller.apiKey,
    );

  beforeAll(async () => {
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    editor = await registerUser(app, "editor@acme.com", "Editor");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "rev@acme.com", "Reviewer");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Comment Mentions" },
      owner.apiKey,
    );
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reviewer.email, permission: "read" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Kickoff", content: "the plan" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Roadmap", content: "the roadmap" },
      owner.apiKey,
    );
  });

  it("notifies the person named in a comment, linking the document", async () => {
    const { status } = await comment(
      owner,
      "nodes/kickoff",
      `does this land, @${editor.email}?`,
    );
    expect(status).toBe(201);

    const rows = await mentions(editor);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain(owner.email);
    expect(rows[0].message).toContain("comment");
    expect(rows[0].message).toContain("Kickoff");
    // The inbox row links to the document the comment is on.
    expect(rows[0].node_id).toBe("nodes/kickoff");
  });

  it("notifies from a read-only reviewer's comment — commenting is read-tier", async () => {
    const { status } = await comment(
      reviewer,
      "nodes/roadmap",
      `@${editor.email} this section needs a date`,
    );
    expect(status).toBe(201);
    const rows = await mentions(editor);
    expect(rows).toHaveLength(2);
    // The inbox is newest-first; assert the reviewer's mention is in there
    // rather than which end it lands on.
    expect(rows.some((r) => r.message.includes(reviewer.email))).toBe(true);
  });

  it("notifies a name added in a reply", async () => {
    const { data } = await comment(owner, "nodes/kickoff", "opening the thread");
    const threadId = data.thread.id;
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations/${threadId}/comments`,
      { body: `pulling in @${reviewer.email}` },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(await mentions(reviewer)).toHaveLength(1);
  });

  it("notifies from a standalone comment (the REST/MCP path)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/roadmap/comments`,
      { body: `@${reviewer.email} please review` },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(await mentions(reviewer)).toHaveLength(2);
  });

  it("stays quiet for the author's own name and for a name nobody carries", async () => {
    const before = (await mentions(owner)).length;
    await comment(
      owner,
      "nodes/kickoff",
      `note to self @${owner.email}, and cc @nobody-here`,
    );
    expect(await mentions(owner)).toHaveLength(before);
  });

  it("spends no email budget when SMTP is not configured", async () => {
    // Mirrors the channel rule: a token spent on a send that was never going
    // to happen bills a no-op and later warns about "skipped" mail.
    const { tryConsume } = await import("../src/shared/rate-limit.js");
    await comment(owner, "nodes/kickoff", `ping @${editor.email}`);
    const key = `mention-email:${nestId}:${owner.email}`;
    // max 1: passes only if the mention above left the bucket empty.
    expect(tryConsume(key, { max: 1, windowMs: 60_000 })).toBe(true);
  });

  it("notifies a person named twice in one comment once", async () => {
    const before = (await mentions(editor)).length;
    await comment(
      owner,
      "nodes/roadmap",
      `@${editor.email} and again @${editor.email}`,
    );
    expect(await mentions(editor)).toHaveLength(before + 1);
  });

  it("notifies once for a comment on an artifact, pointing at the artifact", async () => {
    // An artifact's threads are also projected into a derived `— Annotations`
    // node, and that projection is an ordinary document save — so without a
    // guard the same mention fires twice: once for the comment, once for the
    // derived node (linking the reader at the projection, not the artifact).
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Q3 Deck", content: "<h1>deck</h1>", type: "artifact" },
      owner.apiKey,
    );
    const before = (await mentions(editor)).length;
    await comment(owner, "nodes/q3-deck", `@${editor.email} slide 4?`);
    const rows = await mentions(editor);
    expect(rows).toHaveLength(before + 1);
    // Exactly one row, and it points at the artifact — not a second row
    // pointing at the derived `nodes/q3-deck--annotations` projection.
    expect(rows.filter((r) => r.node_id === "nodes/q3-deck")).toHaveLength(1);
  });

  it("stays quiet for a bare name two people on the nest answer to", async () => {
    // Guessing one of them would notify the wrong John with nothing to show
    // for it, so an ambiguous name resolves to nobody — the guarantee the
    // whole disclosure story rests on, checked through the comment path.
    const johnA = await registerUser(app, "john@acme.com", "John A");
    await resetAuthRateLimit();
    const johnB = await registerUser(app, "john@other.com", "John B");
    await resetAuthRateLimit();
    for (const j of [johnA, johnB]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email: j.email, permission: "write" },
        owner.apiKey,
      );
    }

    await comment(owner, "nodes/kickoff", "cc @john");
    expect(await mentions(johnA)).toHaveLength(0);
    expect(await mentions(johnB)).toHaveLength(0);

    // The full address is unambiguous and still lands.
    await comment(owner, "nodes/kickoff", `cc @${johnB.email}`);
    expect(await mentions(johnA)).toHaveLength(0);
    expect(await mentions(johnB)).toHaveLength(1);
  });

  it("caps how many people one comment can notify", async () => {
    // One comment naming the whole roster would otherwise fan out unbounded:
    // a row, an access check, an email and a connector post per name, from a
    // READ-tier action with no rate limit, repeatable by reposting the same
    // text. The cap bounds the work a single write can cause; nobody
    // legitimately tags this many people in one comment.
    const crowd: Array<{ apiKey: string; email: string }> = [];
    for (let i = 0; i < MAX_MENTION_RECIPIENTS + 3; i++) {
      const person = await registerUser(app, `crowd${i}@acme.com`, `Crowd ${i}`);
      await resetAuthRateLimit();
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email: person.email, permission: "read" },
        owner.apiKey,
      );
      crowd.push(person);
    }

    await comment(
      owner,
      "nodes/kickoff",
      crowd.map((p) => `@${p.email}`).join(" "),
    );

    let notified = 0;
    for (const person of crowd) {
      if ((await mentions(person)).length > 0) notified++;
    }
    expect(notified).toBe(MAX_MENTION_RECIPIENTS);
  });

  it("stays quiet for someone granted a different document", async () => {
    const guest = await registerUser(app, "guest@acme.com", "Guest");
    await resetAuthRateLimit();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/roadmap",
        email: guest.email,
        role: "read",
      },
      owner.apiKey,
    );

    // Named in a document they hold no grant on → nothing, not even a title.
    await comment(owner, "nodes/kickoff", `cc @${guest.email}`);
    expect(await mentions(guest)).toHaveLength(0);

    // Named in the document they were granted → notified.
    await comment(owner, "nodes/roadmap", `cc @${guest.email}`);
    const rows = await mentions(guest);
    expect(rows).toHaveLength(1);
    expect(rows[0].node_id).toBe("nodes/roadmap");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PEOPLE_SUGGEST_ALL_USERS — a mention of someone off the nest is an invite
// ═══════════════════════════════════════════════════════════════════════════

describe("comment mentions with the directory toggle on", () => {
  let app: any;
  let owner: { apiKey: string; email: string };
  let reviewer: { apiKey: string; email: string };
  let outsider: { apiKey: string; email: string };
  let nestId: string;

  const mentions = async (caller: { apiKey: string }) => {
    const { data } = await jsonRequest(app, "GET", "/me/notifications", undefined, caller.apiKey);
    return (data.notifications as Array<{ kind: string }>).filter((n) => n.kind === "mention");
  };

  beforeAll(async () => {
    process.env.PEOPLE_SUGGEST_ALL_USERS = "true";
    setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "rev@acme.com", "Reviewer");
    await resetAuthRateLimit();
    outsider = await registerUser(app, "new@acme.com", "Newcomer");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Directory" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reviewer.email, permission: "read" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Kickoff", content: "the plan" },
      owner.apiKey,
    );
  });

  afterAll(() => {
    delete process.env.PEOPLE_SUGGEST_ALL_USERS;
  });

  it("offers the whole directory in the mention picker", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/mentionable`,
      undefined,
      reviewer.apiKey,
    );
    expect(data.people.map((p: { email: string }) => p.email)).toContain(outsider.email);
  });

  it("a read-only reviewer's mention does not grant access", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations`,
      { body: `cc @${outsider.email}` },
      reviewer.apiKey,
    );
    expect(await mentions(outsider)).toHaveLength(0);
    const { status } = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, outsider.apiKey);
    expect(status).toBe(404);
  });

  it("a write+ author's mention adds the person as a reader and notifies them", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations`,
      { body: `welcome @${outsider.email}` },
      owner.apiKey,
    );
    expect(await mentions(outsider)).toHaveLength(1);
    const { status } = await jsonRequest(app, "GET", `/nests/${nestId}`, undefined, outsider.apiKey);
    expect(status).toBe(200);
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    const row = data.collaborators.find((c: { email: string }) => c.email === outsider.email);
    expect(row?.permission).toBe("read");
  });

  // The sequential case; the concurrent one (two mentions racing before either
  // insert lands) is what the NOT EXISTS in inviteMentioned is for.
  it("mentioning them again leaves one collaborator row, not two", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations`,
      { body: `again @${outsider.email}` },
      owner.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    const rows = data.collaborators.filter((c: { email: string }) => c.email === outsider.email);
    expect(rows).toHaveLength(1);
  });

  // The sequential case; the concurrent one (two mentions racing before either
  // insert lands) is what the NOT EXISTS in inviteMentioned is for.
  it("mentioning them again leaves one collaborator row, not two", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations`,
      { body: `again @${outsider.email}` },
      owner.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    const rows = data.collaborators.filter((c: { email: string }) => c.email === outsider.email);
    expect(rows).toHaveLength(1);
  });

  it("resolves an outsider by local part or display name, and neither when two share it", async () => {
    await registerUser(app, "zed@acme.com", "Zed Zero");
    await resetAuthRateLimit();
    const amy1 = await registerUser(app, "amy@acme.com", "Amy");
    await resetAuthRateLimit();
    await registerUser(app, "amy@other.com", "Amy");
    await resetAuthRateLimit();
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/kickoff/annotations`,
      { body: "hi @zed and @(Amy)" },
      owner.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/collaborators`,
      undefined,
      owner.apiKey,
    );
    const emails = data.collaborators.map((c: { email: string }) => c.email);
    expect(emails).toContain("zed@acme.com");
    expect(emails).not.toContain(amy1.email);
  });
});

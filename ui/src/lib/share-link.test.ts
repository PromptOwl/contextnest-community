/**
 * One-click Share (PO-1365): copy the document's public link, or make one
 * first. Decisions only — the menu wiring is in document-actions.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const copyText = vi.hoisted(() => vi.fn(async (_: string) => true));
vi.mock("./clipboard", () => ({ copyText }));
const api = vi.hoisted(() => ({
  listPublications: vi.fn(),
  createPublication: vi.fn(),
  revokePublication: vi.fn(),
}));
vi.mock("./api", () => api);

import { ONE_CLICK_DEFAULTS, liveLinkFor, shareDocumentLink, shareLinkGate } from "./share-link";
import type { Publication } from "./api";

const NOW = Date.parse("2026-11-16T12:00:00Z");

function pub(over: Partial<Publication> = {}): Publication {
  return {
    id: "p1",
    slug: "abc",
    node_id: "nodes/handbook",
    access_mode: "public",
    comments_enabled: false,
    watermark: false,
    no_download: false,
    created_at: "2026-11-01T00:00:00Z",
    expires_at: null,
    revoked_at: null,
    link: "https://nest.example/p/abc",
    ...over,
  };
}

const onManage = vi.fn();
const share = () =>
  shareDocumentLink({ nestId: "n1", nodeId: "nodes/handbook", title: "Handbook", onManage });

/** The options of the last toast of a kind. */
const last = (kind: "success" | "error") => {
  const calls = toast[kind].mock.calls;
  return calls[calls.length - 1] as [string, any];
};

beforeEach(() => {
  vi.clearAllMocks();
  copyText.mockResolvedValue(true);
  api.listPublications.mockResolvedValue({ count: 0, publishes: [] });
  api.createPublication.mockResolvedValue({ publish: pub({ id: "new", slug: "new" }), link: "https://nest.example/p/new" });
  api.revokePublication.mockResolvedValue({ revoked: true });
});

describe("liveLinkFor — which existing link Share copies", () => {
  it("ignores other documents, revoked links and expired links", () => {
    const links = [
      pub({ id: "other", node_id: "nodes/other" }),
      pub({ id: "revoked", revoked_at: "2026-11-02T00:00:00Z" }),
      pub({ id: "expired", expires_at: "2026-11-10T00:00:00Z" }),
    ];
    expect(liveLinkFor(links, "nodes/handbook", NOW)).toBeNull();
  });

  it("keeps a link that expires later", () => {
    const links = [pub({ id: "soon", expires_at: "2026-12-01T00:00:00Z" })];
    expect(liveLinkFor(links, "nodes/handbook", NOW)?.id).toBe("soon");
  });

  it("prefers an open link over a gated one, then the newest", () => {
    const links = [
      pub({ id: "code-new", access_mode: "code", created_at: "2026-11-15T00:00:00Z" }),
      pub({ id: "public-old", created_at: "2026-11-01T00:00:00Z" }),
      pub({ id: "public-new", created_at: "2026-11-09T00:00:00Z" }),
    ];
    expect(liveLinkFor(links, "nodes/handbook", NOW)?.id).toBe("public-new");
    expect(liveLinkFor(links.slice(0, 1), "nodes/handbook", NOW)?.id).toBe("code-new");
  });
});

describe("shareLinkGate — what the toast says about who can open it", () => {
  it("names each gate in plain words", () => {
    expect(shareLinkGate("public")).toMatch(/anyone with the link/i);
    expect(shareLinkGate("code")).toMatch(/passcode/i);
    expect(shareLinkGate("email")).toMatch(/email/i);
    expect(shareLinkGate("invite")).toMatch(/invited/i);
  });
});

describe("shareDocumentLink", () => {
  it("copies the existing link and makes no new one", async () => {
    api.listPublications.mockResolvedValue({ count: 1, publishes: [pub()] });
    const out = await share();
    expect(out).toEqual({ kind: "existing", link: "https://nest.example/p/abc" });
    expect(api.createPublication).not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledWith("https://nest.example/p/abc");
    const [title, opts] = last("success");
    expect(title).toBe("Public link copied");
    expect(opts.description).toMatch(/anyone with the link/i);
    opts.action.onClick();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("says a copied gated link is gated", async () => {
    api.listPublications.mockResolvedValue({ count: 1, publishes: [pub({ access_mode: "code" })] });
    await share();
    expect(last("success")[1].description).toMatch(/passcode/i);
  });

  it("builds the link from the slug when the server sent none", async () => {
    vi.stubGlobal("window", { location: { origin: "https://here.example" } });
    api.listPublications.mockResolvedValue({ count: 1, publishes: [pub({ link: undefined })] });
    expect(await share()).toEqual({ kind: "existing", link: "https://here.example/p/abc" });
    vi.unstubAllGlobals();
  });

  it("publishes with the dialog's own defaults, copies, and says what became public", async () => {
    const out = await share();
    expect(api.createPublication).toHaveBeenCalledWith("n1", { node_id: "nodes/handbook", ...ONE_CLICK_DEFAULTS });
    expect(ONE_CLICK_DEFAULTS).toEqual({
      access_mode: "public",
      comments_enabled: false,
      watermark: false,
      no_download: false,
      code: null,
      allowlist: [],
      expires_at: null,
    });
    expect(out).toEqual({ kind: "published", link: "https://nest.example/p/new" });
    expect(copyText).toHaveBeenCalledWith("https://nest.example/p/new");
    const [title, opts] = last("success");
    expect(title).toBe("“Handbook” is now public");
    expect(opts.description).toMatch(/anyone with the link can read the approved version/i);
    expect(opts.description).toMatch(/copied/i);
    expect(opts.action.label).toBe("Manage");
    expect(opts.cancel.label).toBe("Undo");
  });

  it("Undo revokes the link it just made", async () => {
    await share();
    await last("success")[1].cancel.onClick();
    expect(api.revokePublication).toHaveBeenCalledWith("n1", "new");
    expect(last("success")[0]).toMatch(/no longer public/i);
  });

  it("Manage opens the publish dialog", async () => {
    await share();
    last("success")[1].action.onClick();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("explains a refusal instead of failing silently, and publishes nothing", async () => {
    api.createPublication.mockRejectedValue(
      new Error("This document has no approved version, so a link to it would show nothing. Get it approved first, then publish."),
    );
    const out = await share();
    expect(out.kind).toBe("refused");
    expect(copyText).not.toHaveBeenCalled();
    const [title, opts] = last("error");
    expect(title).toBe("This document can’t be shared yet");
    expect(opts.description).toMatch(/no approved version/);
  });

  it("explains when the caller may not publish", async () => {
    api.listPublications.mockRejectedValue(
      new Error("Only a nest admin, the nest owner, or the server admin can publish documents."),
    );
    const out = await share();
    expect(out.kind).toBe("refused");
    expect(api.createPublication).not.toHaveBeenCalled();
    expect(last("error")[1].description).toMatch(/Only a nest admin/);
  });

  it("still shows the link when the clipboard refuses", async () => {
    copyText.mockResolvedValue(false);
    const out = await share();
    expect(out).toEqual({ kind: "published", link: "https://nest.example/p/new" });
    const [, opts] = last("success");
    expect(opts.description).toContain("https://nest.example/p/new");
    expect(opts.description).not.toMatch(/copied/i);
  });

  it("does not publish twice when clicked twice", async () => {
    let release!: (v: unknown) => void;
    api.listPublications.mockReturnValue(new Promise((r) => (release = r)));
    const a = share();
    const b = share();
    release({ count: 0, publishes: [] });
    await Promise.all([a, b]);
    expect(api.createPublication).toHaveBeenCalledTimes(1);
  });
});

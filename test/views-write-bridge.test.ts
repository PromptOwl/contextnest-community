/**
 * The view page's write bridge — the only script a view page ever runs, and
 * only when a block opted in with `write_to`. These tests execute the exact
 * shipped source (WRITE_BRIDGE_JS) against a fake window/document/fetch.
 *
 * What the bridge must guarantee (security review focus):
 *  - only a message whose `event.source` IS one of this page's block frames,
 *    from an opaque ("null") origin, is acted on; anything else is ignored;
 *  - the frame's block id comes from the page's own markup, never the message;
 *  - the target must be in THAT block's write_to (server-rendered config);
 *  - the URL, method, credentials and headers are the bridge's own: nothing
 *    the frame supplies beyond ops/base_version reaches fetch;
 *  - per-message op and size caps, one write in flight per frame, a per-minute
 *    budget per frame;
 *  - the result goes back to the source frame only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WRITE_BRIDGE_JS, WRITE_CAPS, writeBridgeCspHash } from "../src/views/write.js";
import { createHash } from "crypto";

type Posted = { msg: any; target: string };
type FakeWin = { postMessage: (msg: any, target: string) => void; posted: Posted[] };

function fakeWin(): FakeWin {
  const w: FakeWin = { posted: [], postMessage: (msg, target) => w.posted.push({ msg, target }) };
  return w;
}

interface Harness {
  dispatch: (ev: { data: any; source: any; origin: string }) => void;
  calls: Array<{ url: string; init: any }>;
  frames: Record<string, FakeWin>;
  resolveFetch: (status: number, body: any) => Promise<void>;
  rejectFetch: () => Promise<void>;
  now: { t: number };
}

const CONFIG = {
  v: 1,
  caps: { maxOps: WRITE_CAPS.MAX_OPS, maxBytes: WRITE_CAPS.MAX_MESSAGE_BYTES, perMinute: WRITE_CAPS.MAX_WRITES_PER_MINUTE },
  frames: {
    h1: { token: "tok-h1-aaaaaaaaaaaaaaaaaaaa", targets: { d: "/nests/n1/nodes/nodes/pipeline/rows" } },
    h2: { token: "tok-h2-bbbbbbbbbbbbbbbbbbbb", targets: { e: "/nests/n1/nodes/nodes/other/rows" } },
  },
};

function load(config: unknown = CONFIG): Harness {
  const frames: Record<string, FakeWin> = { h1: fakeWin(), h2: fakeWin(), h3: fakeWin() };
  const iframes = Object.entries(frames).map(([id, win]) => ({
    contentWindow: win,
    getAttribute: (name: string) => (name === "data-cn-block" ? id : null),
  }));
  let handler: ((ev: any) => void) | null = null;
  const calls: Array<{ url: string; init: any }> = [];
  let pending: { resolve: (v: any) => void; reject: (e: any) => void } | null = null;
  const now = { t: 1_000_000 };
  const window = {
    addEventListener: (type: string, fn: (ev: any) => void) => {
      if (type === "message") handler = fn;
    },
  };
  const document = {
    getElementById: (id: string) =>
      id === "cn-write-config" ? { textContent: typeof config === "string" ? config : JSON.stringify(config) } : null,
    querySelectorAll: (sel: string) => (sel === "iframe[data-cn-block]" ? iframes : []),
  };
  const fetch = (url: string, init: any) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  const DateFake = { now: () => now.t };
  new Function("window", "document", "fetch", "Date", WRITE_BRIDGE_JS)(window, document, fetch, DateFake);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    dispatch: (ev) => handler && handler(ev),
    calls,
    frames,
    now,
    resolveFetch: async (status, body) => {
      pending!.resolve({ status, json: () => Promise.resolve(body) });
      await flush();
      await flush();
    },
    rejectFetch: async () => {
      pending!.reject(new Error("offline"));
      await flush();
      await flush();
    },
  };
}

const OPS = [{ op: "update", key: "r1", set: { stage: "won" } }];
const msg = (extra: Record<string, unknown> = {}) => ({
  type: "nest-write",
  block: "d",
  ops: OPS,
  token: "tok-h1-aaaaaaaaaaaaaaaaaaaa",
  ...extra,
});

let h: Harness;
beforeEach(() => {
  h = load();
});

describe("who may ask", () => {
  it("acts on a message from its own frame, opaque origin", async () => {
    h.dispatch({ data: msg({ id: "req-1" }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(1);
    await h.resolveFetch(200, { state: "draft", version: 4, review_id: "rv1", applied: { appended: 0, updated: 1, deleted: 0 } });
    expect(h.frames.h1.posted).toEqual([
      {
        target: "*",
        msg: {
          type: "nest-write-result",
          id: "req-1",
          ok: true,
          block: "d",
          status: 200,
          state: "draft",
          version: 4,
          review_id: "rv1",
          applied: { appended: 0, updated: 1, deleted: 0 },
        },
      },
    ]);
  });

  it("ignores a source that is not one of the page's frames", () => {
    const outsider = fakeWin();
    h.dispatch({ data: msg(), source: outsider, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(outsider.posted).toHaveLength(0);
  });

  it("ignores a non-opaque origin, even from a real frame (a frame is sandboxed without allow-same-origin)", () => {
    for (const origin of ["http://localhost", "https://evil.example", ""]) {
      h.dispatch({ data: msg(), source: h.frames.h1, origin });
    }
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted).toHaveLength(0);
  });

  it("ignores other message types and malformed data", () => {
    for (const data of [null, "nest-write", { type: "other" }, { type: "nest-write-result" }, 42]) {
      h.dispatch({ data, source: h.frames.h1, origin: "null" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a target outside that frame's write_to — another frame's target included", () => {
    h.dispatch({ data: msg({ block: "e", token: "tok-h2-bbbbbbbbbbbbbbbbbbbb" }), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg({ block: "d" }), source: h.frames.h3, origin: "null" });
    h.dispatch({ data: msg({ block: "__proto__" }), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg({ block: "toString" }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted.map((p) => p.msg.error)).toEqual(["not_writable", "not_writable", "not_writable"]);
    expect(h.frames.h3.posted.map((p) => p.msg.error)).toEqual(["not_writable"]);
  });

  it("a block id in the message cannot pick the frame identity", () => {
    // h3 has no write_to; claiming to be h1 changes nothing.
    h.dispatch({ data: msg({ frame: "h1", htmlBlock: "h1" }), source: h.frames.h3, origin: "null" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("frame token (review round 1: a navigated frame keeps its window handle)", () => {
  it("refuses a message from the right window without the frame's token", () => {
    h.dispatch({ data: msg({ token: undefined }), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg({ token: "guess" }), source: h.frames.h1, origin: "null" });
    // Another frame's token does not work either.
    h.dispatch({ data: msg({ token: "tok-h2-bbbbbbbbbbbbbbbbbbbb" }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted.map((p) => p.msg.error)).toEqual(["bad_token", "bad_token", "bad_token"]);
  });

  it("the token is never sent to the server", () => {
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls[0].init.body).not.toContain("tok-h1");
  });
});

describe("what reaches the network", () => {
  it("only the config URL, POST, same-origin credentials, JSON — frame-supplied url/headers are ignored", () => {
    h.dispatch({
      data: msg({ url: "https://evil.example/x", headers: { Authorization: "Bearer stolen" }, method: "DELETE", base_version: 3 }),
      source: h.frames.h1,
      origin: "null",
    });
    expect(h.calls).toHaveLength(1);
    const { url, init } = h.calls[0];
    expect(url).toBe("/nests/n1/nodes/nodes/pipeline/rows");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ ops: OPS, base_version: 3, submit_review: true });
  });

  it("drops a base_version that is not a positive integer", () => {
    h.dispatch({ data: msg({ base_version: "3" }), source: h.frames.h1, origin: "null" });
    expect(JSON.parse(h.calls[0].init.body)).not.toHaveProperty("base_version");
  });

  it("refuses empty or over-cap ops without a request", () => {
    h.dispatch({ data: msg({ ops: [] }), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg({ ops: "x" }), source: h.frames.h1, origin: "null" });
    const many = Array.from({ length: WRITE_CAPS.MAX_OPS + 1 }, () => OPS[0]);
    h.dispatch({ data: msg({ ops: many }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted.map((p) => p.msg.error)).toEqual(["bad_request", "bad_request", "too_many_ops"]);
  });

  it("counts the size cap in UTF-8 bytes, not characters", () => {
    const n = Math.floor(WRITE_CAPS.MAX_MESSAGE_BYTES / 3) + 10; // ~1/3 the cap in chars, over it in bytes
    const big = [{ op: "append", row: { id: "x", note: "€".repeat(n) } }];
    h.dispatch({ data: msg({ ops: big }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted[0].msg.error).toBe("too_large");
  });

  it("refuses an oversized message without a request", () => {
    const big = [{ op: "append", row: { id: "x", note: "z".repeat(WRITE_CAPS.MAX_MESSAGE_BYTES) } }];
    h.dispatch({ data: msg({ ops: big }), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(0);
    expect(h.frames.h1.posted[0].msg.error).toBe("too_large");
  });

  it("one write in flight per frame", async () => {
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(1);
    expect(h.frames.h1.posted[0].msg.error).toBe("busy");
    await h.resolveFetch(200, { state: "published", version: 2 });
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(2);
  });

  it(`at most ${WRITE_CAPS.MAX_WRITES_PER_MINUTE} writes a minute per frame`, async () => {
    for (let i = 0; i < WRITE_CAPS.MAX_WRITES_PER_MINUTE; i++) {
      h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
      await h.resolveFetch(200, { state: "published", version: i + 2 });
    }
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(WRITE_CAPS.MAX_WRITES_PER_MINUTE);
    expect(h.frames.h1.posted.at(-1)!.msg.error).toBe("rate_limited");
    h.now.t += 61_000;
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(WRITE_CAPS.MAX_WRITES_PER_MINUTE + 1);
  });
});

describe("results", () => {
  it("a refusal from the server is relayed with its status and current_version", async () => {
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    await h.resolveFetch(409, { error: "Version conflict", current_version: 7, rejected: "secret?" });
    expect(h.frames.h1.posted[0].msg).toEqual({
      type: "nest-write-result",
      ok: false,
      block: "d",
      status: 409,
      error: "Version conflict",
      current_version: 7,
    });
  });

  it("a 403 (a reader) is relayed as a refusal", async () => {
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    await h.resolveFetch(403, { error: "You don't have edit access here." });
    expect(h.frames.h1.posted[0].msg).toMatchObject({ ok: false, status: 403 });
  });

  it("a network failure frees the frame and reports network_error", async () => {
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    await h.rejectFetch();
    expect(h.frames.h1.posted[0].msg).toMatchObject({ ok: false, error: "network_error" });
    h.dispatch({ data: msg(), source: h.frames.h1, origin: "null" });
    expect(h.calls).toHaveLength(2);
  });

  it("an over-long or non-string request id is not echoed", () => {
    h.dispatch({ data: msg({ ops: [], id: "x".repeat(65) }), source: h.frames.h1, origin: "null" });
    h.dispatch({ data: msg({ ops: [], id: { evil: 1 } }), source: h.frames.h1, origin: "null" });
    for (const p of h.frames.h1.posted) expect(p.msg).not.toHaveProperty("id");
  });
});

describe("config", () => {
  it("does nothing without a readable config", () => {
    const bad = load("{not json");
    bad.dispatch({ data: msg(), source: bad.frames.h1, origin: "null" });
    expect(bad.calls).toHaveLength(0);
  });

  it("the CSP hash is the sha256 of the exact script text", () => {
    const expected = createHash("sha256").update(WRITE_BRIDGE_JS, "utf8").digest("base64");
    expect(writeBridgeCspHash()).toBe(`'sha256-${expected}'`);
  });
});

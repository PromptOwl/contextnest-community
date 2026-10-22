/** CU-wdqcq05jhm: small units of the public docs site. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { PRIVATE_HOST, isPublicHost } from "../src/site/indexnow.js";
import { config } from "../src/config.js";

describe("DOCS_SITES parsing", () => {
  const savedBase = process.env.PUBLIC_BASE_URL;
  afterEach(() => {
    delete process.env.DOCS_SITES;
    if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedBase;
  });
  it("ignores, with a warning, an entry for this server's own host", () => {
    process.env.PUBLIC_BASE_URL = "https://nest.example.com";
    process.env.DOCS_SITES = "Nest.Example.com=self, nest.example.com.:443=self2, docs.example.com=n1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...config.DOCS_SITES]).toEqual([["docs.example.com", "n1"]]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it("warns that it can't catch this server's own host when PUBLIC_BASE_URL is unset", () => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.DOCS_SITES = "docs.example.com=n1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...config.DOCS_SITES]).toEqual([["docs.example.com", "n1"]]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PUBLIC_BASE_URL is not/));
    warn.mockRestore();
  });
  it("splits each pair on the first = only, and skips pairs without one", () => {
    process.env.PUBLIC_BASE_URL = "https://nest.example.com";
    process.env.DOCS_SITES = " Docs.Example.com = id=with=equals , broken, b.example=2";
    expect([...config.DOCS_SITES]).toEqual([
      ["docs.example.com", "id=with=equals"],
      ["b.example", "2"],
    ]);
  });
});

describe("IndexNow private-host check", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.1", "169.254.1.1", "[::1]", "wiki.corp.local", "docs.internal", "nas.lan", "box.home.arpa"])(
    "treats %s as private",
    (host) => expect(PRIVATE_HOST.test(host)).toBe(true),
  );
  it.each([
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:a00:1]/",
    "https://8.8.8.8/",
    "https://[2001:4860::8888]/",
    "https://0x7f000001/",
    "https://site-origin.invalid/d/x",
    "https://wiki.corp.local/",
    "https://localhost/",
  ])("isPublicHost refuses %s", (u) => expect(isPublicHost(new URL(u))).toBe(false));
  it.each(["https://docs.acme.dev/", "https://nest.promptowl.ai/d/docs"])("isPublicHost accepts %s", (u) =>
    expect(isPublicHost(new URL(u))).toBe(true),
  );
  it.each(["docs.example.com", "172.32.0.1", "172.15.0.1", "local.example.com", "internal.example.com"])(
    "treats %s as public",
    (host) => expect(PRIVATE_HOST.test(host)).toBe(false),
  );
});

// CU-wdqcq05ran: the docs site and the SPA reader pick the same home node from
// a reader_home_node value. One rule, mirrored in the UI; this keeps them equal.
describe("reader home node resolution (site ↔ reader parity)", () => {
  const ids = ["nodes/docs/overview", "nodes/docs/welcome", "nodes/guides/welcome", "nodes/welcome-guide", "nodes/Intro", "guides/setup"];
  const cases: Array<[string | null, string | undefined]> = [
    ["nodes/docs/welcome", "nodes/docs/welcome"], // full id
    ["NODES/Docs/Welcome", "nodes/docs/welcome"], // full id, any case
    ["nodes/guides/welcome", "nodes/guides/welcome"], // exact id beats a leaf twin listed first
    ["welcome", "nodes/docs/welcome"], // bare slug, two pages share it: lowest id wins
    ["Welcome", "nodes/docs/welcome"],
    ["intro", "nodes/Intro"], // leaf compares case-insensitively both ways
    ["docs/welcome", "nodes/docs/welcome"], // id without the nodes/ prefix: same leaf
    ["setup", "guides/setup"], // an id without the nodes/ prefix leafs the same on both sides
    ["nodes/gone/intro", "nodes/Intro"], // a full id that matches nothing still falls back by leaf
    ["  welcome  ", "nodes/docs/welcome"], // padded input is trimmed on both sides
    ["welcome/", undefined], // a trailing slash leaves an empty slug: no match on either side
    ["no-such-page", undefined],
    ["", undefined],
    [null, undefined],
  ];

  it.each(cases)("server: %j → %j", async (home, want) => {
    const { pickHomeNode } = await import("../src/shared/reader-home.js");
    expect(pickHomeNode(ids, home, (id) => id)).toBe(want);
  });

  it.each(cases)("reader UI: %j → %j", async (home, want) => {
    const { pickHomeNode } = await import("../ui/src/lib/nest-caps");
    const nodes = ids.map((id) => ({ id }));
    expect(pickHomeNode(nodes, home)?.id).toBe(want);
  });

  it("is independent of list order", async () => {
    const { pickHomeNode } = await import("../src/shared/reader-home.js");
    expect(pickHomeNode([...ids].reverse(), "welcome", (id) => id)).toBe("nodes/docs/welcome");
  });
});

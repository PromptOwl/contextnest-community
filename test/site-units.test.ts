/** CU-wdqcq05jhm: small units of the public docs site. */
import { describe, it, expect, afterEach } from "vitest";
import { PRIVATE_HOST } from "../src/site/indexnow.js";
import { config } from "../src/config.js";

describe("DOCS_SITES parsing", () => {
  afterEach(() => {
    delete process.env.DOCS_SITES;
  });
  it("splits each pair on the first = only, and skips pairs without one", () => {
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
  it.each(["docs.example.com", "172.32.0.1", "172.15.0.1", "local.example.com", "internal.example.com"])(
    "treats %s as public",
    (host) => expect(PRIVATE_HOST.test(host)).toBe(false),
  );
});

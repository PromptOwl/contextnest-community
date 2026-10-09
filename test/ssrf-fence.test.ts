/**
 * The SSRF fence for connectors and agent fetches: names are judged as names,
 * address literals by range — including IPv4 carried inside IPv6.
 */
import { describe, it, expect } from "vitest";
import { isForbiddenConnectorHost, isSafeConnectorUrl, embeddedIPv4 } from "../src/notify/dispatch.js";
import { isPrivateAddress } from "../src/metacognition/net.js";

describe("connector host fence", () => {
  it("does not mistake a name for an IPv6 prefix", () => {
    for (const name of ["fd-feeds.com", "fc-barcelona.example", "fe80-news.io", "feeds.example.com"]) {
      expect(isForbiddenConnectorHost(name), name).toBe(false);
    }
    expect(isSafeConnectorUrl("https://fd-feeds.com/rss")).toBe(true);
  });

  it("refuses local names and private IPv6 literals", () => {
    for (const h of ["localhost", "api.localhost", "printer.local", "db.internal", "fd00::1", "[fc00::1]", "fe80::1", "fec0::1", "ff02::1", "::1", "::"]) {
      expect(isForbiddenConnectorHost(h), h).toBe(true);
    }
  });

  it("refuses 198.18/15, multicast and reserved IPv4", () => {
    for (const h of ["198.18.0.1", "198.19.255.255", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255", "192.0.0.8"]) {
      expect(isForbiddenConnectorHost(h), h).toBe(true);
    }
    expect(isForbiddenConnectorHost("198.20.0.1")).toBe(false);
  });

  it("unwraps IPv4 carried in IPv6: mapped, compatible, NAT64 and 6to4", () => {
    expect(embeddedIPv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(embeddedIPv4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIPv4("::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIPv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIPv4("64:ff9b::10.0.0.1")).toBe("10.0.0.1");
    expect(embeddedIPv4("2002:a9fe:a9fe::1")).toBe("169.254.169.254");
    for (const h of ["::ffff:7f00:1", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:0a00:0001::", "64:ff9b:1::1", "2001:0:4136:e378::1"]) {
      expect(isForbiddenConnectorHost(h), h).toBe(true);
    }
    // A public address carried the same ways stays reachable.
    for (const h of ["64:ff9b::5db8:d822", "2002:5db8:d822::1", "2606:4700::1111"]) {
      expect(isForbiddenConnectorHost(h), h).toBe(false);
    }
  });
});

describe("agent address fence", () => {
  it("adds carrier-grade NAT, also when it arrives inside IPv6", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:100.100.1.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::6440:1")).toBe(true);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

/**
 * Message-log redaction: no credential class may reach outbound_messages.
 * Pure — exercises redact()/webhookTarget()/viaProxy() directly.
 */
import { describe, it, expect } from "vitest";
import { redact, webhookTarget, viaProxy } from "../src/notify/outbound-log.js";

describe("message log redaction", () => {
  it("scrubs an exact secret such as a temporary password", () => {
    const out = redact("Temporary password: Xk9#pLm2Qz\nSign in now.", ["Xk9#pLm2Qz"]);
    expect(out).not.toContain("Xk9#pLm2Qz");
    expect(out).toContain("[REDACTED]");
  });

  it("scrubs magic-link and other credential query params", () => {
    const link = "https://nest.example.com/p/board-pack/verify?token=abc123DEF456ghi&x=1";
    const out = redact(`Open it: ${link}`);
    expect(out).not.toContain("abc123DEF456ghi");
    expect(out).toContain("/p/board-pack/verify?token=[REDACTED]&x=1");
    expect(redact("https://h/cb?code=s3cr3t&state=ok")).toBe("https://h/cb?code=[REDACTED]&state=ok");
    expect(redact("https://h/x?signature=deadbeef")).not.toContain("deadbeef");
  });

  it("scrubs hook tokens, API keys, Bearer tokens and provider keys", () => {
    const body = [
      "hook hk_live_9f8e7d6c5b4a",
      "key cnst_AbCdEf0123456789",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      "openai sk-proj-abcdefghijklmnop1234",
      "slack xoxb-1234567890-abcdef",
    ].join("\n");
    const out = redact(body);
    for (const leak of ["9f8e7d6c5b4a", "AbCdEf0123456789", "eyJhbGciOiJIUzI1NiJ9", "abcdefghijklmnop1234", "1234567890-abcdef"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("reduces webhook URLs to host + hash, never the path", () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX";
    const out = redact(`posted to ${url}`);
    expect(out).not.toContain("XXXXSECRETXXXX");
    expect(out).toMatch(/hooks\.slack\.com#[0-9a-f]{12}/);
    expect(webhookTarget(url)).toBe(webhookTarget(url));
    expect(webhookTarget(url)).not.toBe(webhookTarget(`${url}2`));
    expect(redact("https://acme.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456")).not.toContain("IncomingWebhook");
  });

  it("scrubs secrets in fragments, escaped links, JSON and other header/key shapes", () => {
    const body = [
      "https://h/cb#access_token=FRAGSECRET1",
      "https://h/x?a=1&amp;token=AMPSECRET22",
      "https://h/x?api_key=APIKEY33&client_secret=CLIENT44",
      '{"token":"JSONTOK55","api_key": "JSONKEY66","note":"keep"}',
      "authorization: bearer lowercasebearer77",
      "Authorization: Basic dXNlcjpwYXNzOTk=",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
      "pat github_pat_11ABCDEFG0123456789_abcdefghij",
      "aws AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const out = redact(body);
    for (const leak of [
      "FRAGSECRET1", "AMPSECRET22", "APIKEY33", "CLIENT44", "JSONTOK55", "JSONKEY66",
      "lowercasebearer77", "dXNlcjpwYXNzOTk", "abcdefghijklmnopqrstuvwxyz0123", "11ABCDEFG0123456789", "IOSFODNN7EXAMPLE",
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('"note":"keep"');
  });

  it("hashes an escaped Slack webhook URL the same as the raw one", () => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX";
    expect(redact(`&lt;${url}&gt;`)).toBe(`&lt;${webhookTarget(url)}&gt;`);
  });

  it("leaves ordinary text alone", () => {
    const s = 'Alice mentioned you in "Q3 plan" — https://nest.example.com/nests/n1/doc?view=raw. Basic setup done. Basic Configuration.';
    expect(redact(s)).toBe(s);
  });
});

describe("via_proxy", () => {
  it("follows HTTPS_PROXY / NO_PROXY", () => {
    const env = { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "localhost,.internal.corp,10.0.0.5" };
    expect(viaProxy("https://hooks.slack.com/x", env)).toBe(true);
    expect(viaProxy("https://hooks.internal.corp/x", env)).toBe(false);
    expect(viaProxy("https://internal.corp/x", env)).toBe(false);
    expect(viaProxy("http://localhost:9000/x", env)).toBe(false);
    expect(viaProxy("https://hooks.slack.com/x", {})).toBe(false);
    expect(viaProxy("https://hooks.slack.com/x", { ...env, NO_PROXY: "*" })).toBe(false);
    expect(viaProxy("http://plain.example/x", { HTTPS_PROXY: "http://p:1" })).toBe(false);
  });
});

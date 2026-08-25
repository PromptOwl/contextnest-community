import { describe, it, expect, beforeEach } from "vitest";
import { setupTestEnv, createTestApp } from "./helpers";

// The SPA catch-all used to answer EVERY unmatched GET with the index.html
// shell and a 200. Non-browser callers parse what they get, so a mistyped API
// path, a discovery fetch, or a missing asset came back as HTML and failed
// somewhere confusing — the reported case being an MCP client's JSON.parse
// dying on `Unexpected token '<', "<!DOCTYPE "...`. The shell is now served
// only to browser document navigations; everything else gets a JSON 404.
describe("unmatched-route fallback", () => {
  beforeEach(() => setupTestEnv());

  const expectJson404 = async (res: Response) => {
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  };

  it("404s JSON for a discovery fetch that sends no Accept header", async () => {
    const app = await createTestApp("key");
    // Exactly what the MCP SDK sends — no Accept, no Sec-Fetch-Mode.
    const res = await app.request(
      "http://localhost/.well-known/oauth-authorization-server",
      { headers: { "MCP-Protocol-Version": "2025-06-18" } },
    );
    await expectJson404(res);
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/openid-configuration",
  ])("404s JSON for %s", async (path) => {
    const app = await createTestApp("key");
    await expectJson404(await app.request(`http://localhost${path}`));
  });

  it("404s JSON for a mistyped API path fetched as JSON", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/nesst", {
      headers: { Accept: "application/json" },
    });
    await expectJson404(res);
  });

  it("404s JSON for a missing asset requested with Accept: */*", async () => {
    const app = await createTestApp("key");
    // A <script src> miss falls through serveStatic to the catch-all. Serving
    // the HTML shell here makes the browser execute markup as JavaScript.
    const res = await app.request("http://localhost/assets/gone-abc123.js", {
      headers: { Accept: "*/*" },
    });
    await expectJson404(res);
  });

  it("404s JSON for a non-GET miss (the OAuth /register probe)", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await expectJson404(res);
  });

  it("still serves the SPA shell to a browser navigation", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/dashboard", {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Mode": "navigate",
      },
    });
    // 200 with the built UI present, serveStatic's own 404 when dist/web3
    // isn't built — either way it reached the static handler, not the guard.
    expect(await res.text()).not.toContain('{"error":"Not found"}');
  });

  it("serves the SPA shell on Accept alone (older browsers, no Sec-Fetch-Mode)", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/dashboard", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(await res.text()).not.toContain('{"error":"Not found"}');
  });
});

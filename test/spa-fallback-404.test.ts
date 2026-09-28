import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, authed } from "./helpers";

// The SPA catch-all used to answer EVERY unmatched GET with the index.html
// shell and a 200. Non-browser callers parse what they get, so a mistyped API
// path, a discovery fetch, or a missing asset came back as HTML and failed
// somewhere confusing — the reported case being an MCP client's JSON.parse
// dying on `Unexpected token '<', "<!DOCTYPE "...`. The shell is now served
// only to browser document navigations; everything else gets a JSON 404.
describe("unmatched-route fallback", () => {
  // The shell the navigation tests below expect to reach. app.ts resolves its
  // static root at import time (`dist/web3`, else `src/web3`), so without a
  // built UI serveStatic finds nothing, falls through to app.notFound, and
  // answers the SAME JSON 404 the guard does — leaving those two tests unable
  // to tell "the guard rejected the navigation" from "there was no shell to
  // serve", and failing on any checkout where `npm run build:ui` hasn't run.
  // Standing up a minimal shell is the precondition they are really asserting
  // against. A real build is left alone and never deleted.
  const uiDir = join(process.cwd(), "dist", "web3");
  const shell = join(uiDir, "index.html");
  let shellIsOurs = false;
  let dirIsOurs = false;

  beforeAll(() => {
    if (existsSync(shell)) return;
    dirIsOurs = !existsSync(uiDir);
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(shell, "<!DOCTYPE html><title>ContextNest</title>");
    shellIsOurs = true;
  });

  afterAll(() => {
    // Take the directory too when we made it: app.ts picks its static root by
    // the first candidate that EXISTS, so an empty `dist/web3` left behind
    // would silently redirect another suite's resolution.
    if (shellIsOurs) rmSync(shell, { force: true });
    if (dirIsOurs) rmSync(uiDir, { recursive: true, force: true });
  });

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
    // Reached the static handler, not the guard.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!DOCTYPE html");
  });

  it("serves the SPA shell on Accept alone (older browsers, no Sec-Fetch-Mode)", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/dashboard", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!DOCTYPE html");
  });

  // GET /teams is both the Teams API and the browser URL for the client's
  // Teams page — a hard reload used to be answered by the API's raw
  // `{"teams": [...]}` instead of the app shell. The guard in app.ts checks
  // the same document-navigation signal as the catch-all above, ahead of the
  // teamRoutes mount.
  it("serves the SPA shell for a browser navigation to /teams", async () => {
    const app = await createTestApp("key");
    const res = await app.request("http://localhost/teams", {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Mode": "navigate",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!DOCTYPE html");
  });

  it("still answers GET /teams with JSON for the app's own API call", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "teams-guard@example.com");
    const res = await app.request("http://localhost/teams", {
      headers: { Accept: "application/json", ...authed(user.apiKey) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ teams: [] });
  });
});

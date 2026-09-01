/**
 * Wire contract for the engine's per-vault write-lock timeout: a
 * VaultLockTimeoutError thrown by an engine operation must surface as a
 * retryable error — HTTP 503 + Retry-After on REST, a typed VAULT_BUSY
 * structuredContent code on MCP — never a generic 500.
 *
 * The error thrown here is the engine's own VaultLockTimeoutError, so this
 * pins detection to the real class rather than a lookalike. What it cannot
 * exercise is the acquire path itself: the timeout is a fixed 20s with no
 * knob, so genuinely losing the race would cost the suite 20 seconds per
 * assertion. Injecting the engine's error at the operation boundary tests the
 * half that lives here — that isVaultLockTimeout (src/shared/errors.ts, which
 * matches name/code rather than instanceof to survive the dual CJS/ESM package
 * boundary) recognises it, and that every surface maps it to a retryable
 * answer.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { VaultLockTimeoutError } from "@promptowl/contextnest-engine";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let nodeId: string;
let engineApi: any;

const vaultLockTimeout = () => new VaultLockTimeoutError("/x");

/** Reject mutating ops only — reads keep working so requests reach the write. */
function makeVaultBusy() {
  const realRun = engineApi.run.bind(engineApi);
  return vi
    .spyOn(engineApi, "run")
    .mockImplementation((name: unknown, ...rest: unknown[]) =>
      typeof name === "string" &&
      /^context_(create|update|publish|delete|import)$/.test(name)
        ? Promise.reject(vaultLockTimeout())
        : realRun(name, ...rest),
    );
}

async function parseMcp(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  // Same module registry as the app (createTestApp resets modules first), so
  // this is the exact engineApi instance the routes call.
  ({ engineApi } = await import("../src/nodes/engine.js"));

  const created = await jsonRequest(app, "POST", "/nests", { name: "Busy Nest" });
  nestId = created.data.nest.id;
  const node = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Busy Doc",
    content: "# base",
  });
  nodeId = node.data.node.id;
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => env.cleanup());

describe("vault write-lock timeout on the wire", () => {
  it("REST: PATCH surfaces 503 with Retry-After, not a 500", async () => {
    makeVaultBusy();
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# blocked" }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.json();
    expect(body.error).toMatch(/busy/i);
  });

  it("MCP: context_update returns isError with code VAULT_BUSY", async () => {
    makeVaultBusy();
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "context_update",
          arguments: { id: nodeId, content: "# blocked" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await parseMcp(res);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ code: "VAULT_BUSY" });
  });

  it("writes work again once the lock frees", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# recovered" }),
    });
    expect(res.status).toBe(200);
  });
});

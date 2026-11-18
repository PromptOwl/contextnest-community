import { describe, it, expect, vi, afterEach } from "vitest";
import { rotateAgentWebhookSecret, setAgentWebhook } from "./api";

// Agent webhooks (PO-1181): a rotate sends no URL, so the panel's add-new URL
// box can never repoint an existing handle.
describe("agent webhook writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const body = async (call: () => Promise<unknown>) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ webhook: { handle: "grok" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await call();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/nests/n1/agent-webhooks/grok");
    expect(init.method).toBe("PUT");
    return JSON.parse(String(init.body));
  };

  it("sends the URL on a save", async () => {
    expect(await body(() => setAgentWebhook("n1", "grok", "https://runner.example.com/wake"))).toEqual({
      url: "https://runner.example.com/wake",
    });
  });

  it("sends only rotate on a rotate", async () => {
    expect(await body(() => rotateAgentWebhookSecret("n1", "grok"))).toEqual({ rotate: true });
  });
});

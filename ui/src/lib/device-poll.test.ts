import { describe, it, expect, vi, afterEach } from "vitest";
import { pollDeviceAuth } from "./api";

// CU-wdqcq04uwd — the device-login secret goes in the POST body, never the URL,
// so server and proxy access logs can't record it.

describe("pollDeviceAuth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs code and client_secret in the body, with none in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollDeviceAuth("C1", "S3CRET")).resolves.toEqual({ status: "pending" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("S3CRET");
    expect(url).not.toContain("?");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ code: "C1", client_secret: "S3CRET" });
  });
});

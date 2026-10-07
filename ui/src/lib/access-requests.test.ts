import { describe, it, expect } from "vitest";
import {
  accessOfferFromError,
  describeAccessTarget,
  nestIdFromApiPath,
} from "./access-requests";

describe("accessOfferFromError", () => {
  const body = {
    error: "no",
    code: "forbidden",
    can_request_access: true,
    target: { type: "node", id: "nodes/pricing" },
    level: "write",
  };

  it("turns a refused write that can be asked about into an offer", () => {
    expect(accessOfferFromError("/nests/n%201/nodes/nodes/pricing", 403, body)).toEqual({
      nestId: "n 1",
      target: { type: "node", id: "nodes/pricing" },
      level: "write",
      request: null,
    });
  });

  it("carries a pending or denied request along", () => {
    const offer = accessOfferFromError("/nests/n1/nodes", 403, {
      ...body,
      target: { type: "nest", id: "n1" },
      access_request: { id: "r1", status: "pending", created_at: "2026-10-07 10:00:00" },
    });
    expect(offer?.request?.status).toBe("pending");
  });

  it("ignores everything else", () => {
    expect(accessOfferFromError("/nests/n1/nodes", 404, body)).toBeNull();
    expect(accessOfferFromError("/nests/n1/nodes", 403, { error: "no" })).toBeNull();
    expect(accessOfferFromError("/admin/settings", 403, body)).toBeNull();
    expect(
      accessOfferFromError("/nests/n1/nodes", 403, { ...body, target: { type: "x", id: "y" } }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("reads the nest id off an API path", () => {
    expect(nestIdFromApiPath("/nests/abc/nodes?x=1")).toBe("abc");
    expect(nestIdFromApiPath("/me/work")).toBeNull();
  });
  it("describes targets in plain words", () => {
    expect(describeAccessTarget({ type: "node", id: "nodes/x" }, "Pricing")).toBe('"Pricing"');
    expect(describeAccessTarget({ type: "nest", id: "n" })).toBe("this nest");
    expect(describeAccessTarget({ type: "folder", id: "gtm" })).toBe('the folder "gtm"');
  });
});

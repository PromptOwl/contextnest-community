import { describe, it, expect, vi, afterEach } from "vitest";
import { addCollaborator, BILLING_CONFIRM_EVENT, type BillingConfirmRequest } from "./api";

// CU-wdqcq04t06 — a role change that raises someone's billed class asks first:
// the 409 billing_confirm goes to the host, and a yes resends with the header.

const CHANGES = [{ userId: "u1", email: "rita@x.com", from: "viewer", to: "subscriber" }];

function stub(answer: boolean | null) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const confirmed = (init.headers as Record<string, string>)["X-Confirm-Billing"] === "true";
    return confirmed
      ? new Response(JSON.stringify({ ok: true }), { status: 201 })
      : new Response(JSON.stringify({ error: "raise", code: "billing_confirm", changes: CHANGES }), { status: 409 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const win = new EventTarget();
  const seen: BillingConfirmRequest[] = [];
  if (answer !== null) {
    win.addEventListener(BILLING_CONFIRM_EVENT, (e) => {
      e.preventDefault();
      const req = (e as CustomEvent<BillingConfirmRequest>).detail;
      seen.push(req);
      req.resolve(answer);
    });
  }
  vi.stubGlobal("window", win);
  return { fetchMock, seen };
}

describe("billing confirm on a raise", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resends with X-Confirm-Billing once the user confirms", async () => {
    const { fetchMock, seen } = stub(true);
    await expect(addCollaborator("n1", { email: "rita@x.com", permission: "write" })).resolves.toEqual({ ok: true });
    expect(seen[0].changes).toEqual(CHANGES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("saves nothing and says so when the user cancels", async () => {
    const { fetchMock } = stub(false);
    await expect(addCollaborator("n1", { email: "rita@x.com", permission: "write" })).rejects.toThrow(/Cancelled/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses without resending when no dialog host is mounted", async () => {
    const { fetchMock } = stub(null);
    await expect(addCollaborator("n1", { email: "rita@x.com", permission: "write" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

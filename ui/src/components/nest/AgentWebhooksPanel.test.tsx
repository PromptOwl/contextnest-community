/** Agent webhooks panel (PO-1189): each row's last delivery in words. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentWebhookDelivery } from "../../lib/api";
import { DeliveryStatus, deliverySummary } from "./AgentWebhooksPanel";

const delivery = (over: Partial<AgentWebhookDelivery> = {}): AgentWebhookDelivery => ({
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
  status: "ok",
  reason: null,
  attempts: 1,
  event: "agent.mention",
  ...over,
});

describe("AC-UX-16 each webhook row shows its last delivery", () => {
  it("says nothing was sent before the first delivery", () => {
    expect(deliverySummary(null)).toEqual({ tone: "none", text: "Nothing sent yet" });
  });

  it("tells a delivered mention from a delivered test", () => {
    expect(deliverySummary(delivery())).toEqual({ tone: "ok", text: "Mention delivered" });
    expect(deliverySummary(delivery({ event: "agent.test" }))).toEqual({ tone: "ok", text: "Test delivered" });
  });

  it("gives the reason a delivery failed, and how many tries it took", () => {
    expect(deliverySummary(delivery({ status: "failed", reason: "HTTP 502", attempts: 3 }))).toEqual({
      tone: "failed",
      text: "Mention failed: HTTP 502 after 3 tries",
    });
    expect(deliverySummary(delivery({ status: "failed", reason: "not a public address", event: "agent.test" })).text).toBe(
      "Test failed: not a public address",
    );
  });

  it("renders the status with its time, relative, full on hover", () => {
    const h = renderToStaticMarkup(<DeliveryStatus delivery={delivery({ status: "failed", reason: "timed out" })} />);
    expect(h).toContain('data-status="failed"');
    expect(h).toContain("Mention failed: timed out");
    expect(h).toMatch(/<time[^>]*title="[^"]+"[^>]*>· 5m ago<\/time>/);
  });
});

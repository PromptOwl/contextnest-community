/** PO-1193 (AC-EED-08): the banner offers Approve / Reject only to someone who may decide. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalEditBanner } from "./ExternalEditBanner";

const pending = {
  suggestion_id: "s_2026-11-09T10-00-00-000Z_abcdef01",
  detected_at: "2026-11-09T10:00:00.000Z",
  source: "out-of-band-edit",
  proposed_hash: "sha256:abcdef01",
};
const html = (canDecide: boolean) =>
  renderToStaticMarkup(
    <ExternalEditBanner nestId="n" nodeId="nodes/pricing-page" pending={pending} canDecide={canDecide} onResolved={() => {}} />,
  );

describe("ExternalEditBanner", () => {
  it("someone who may decide gets Approve, Reject and the diff", () => {
    const h = html(true);
    expect(h).toContain("This file was edited outside the app.");
    expect(h).toContain('data-testid="external-edit-approve"');
    expect(h).toContain('data-testid="external-edit-reject-toggle"');
    expect(h).toContain('data-testid="external-edit-view-diff"');
  });

  it("someone who may not decide still gets the notice and the diff, but no Approve or Reject", () => {
    const h = html(false);
    expect(h).toContain("This file was edited outside the app.");
    expect(h).toContain('data-testid="external-edit-view-diff"');
    expect(h).not.toContain('data-testid="external-edit-approve"');
    expect(h).not.toContain('data-testid="external-edit-reject-toggle"');
  });
});

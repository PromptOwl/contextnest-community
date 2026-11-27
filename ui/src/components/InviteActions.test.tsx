/** po-1449: accepting an invite shows that it is in progress, on its row only. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteActions, type InviteBusy } from "./InviteActions";

const html = (busy: InviteBusy) =>
  renderToStaticMarkup(<InviteActions busy={busy} onAccept={() => {}} onDecline={() => {}} />);

describe("po-1449 InviteActions", () => {
  it("shows a spinner and Accepting…, with both buttons disabled", () => {
    const h = html("accept");
    expect(h).toContain("animate-spin");
    expect(h).toContain("Accepting…");
    expect(h.match(/disabled=""/g)).toHaveLength(2);
  });
  it("a row with no request stays usable", () => {
    const h = html(undefined);
    expect(h).toContain(">Accept<");
    expect(h).not.toContain('disabled=""');
    expect(h).not.toContain("animate-spin");
  });
  it("a decline disables the row without saying Accepting…", () => {
    expect(html("decline")).not.toContain("Accepting");
    expect(html("decline").match(/disabled=""/g)).toHaveLength(2);
  });
});

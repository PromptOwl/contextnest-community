/** PO-1436: a connected Slack workspace offers Disconnect; a pending install does not. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectStep, type SetupState } from "./SetupWizard";
import type { SurfacesInstallRef } from "../../../lib/api";

const install = (status: SurfacesInstallRef["status"]): SurfacesInstallRef => ({ id: "i1", surface: "slack", mode: "hosted", status, home_nest_id: null });
const state = (inst: SurfacesInstallRef | null) =>
  ({
    install: inst,
    status: { slack_hosted: true, org_name: null, installs: inst ? [inst] : [] },
    settings: null,
    nests: [],
    reload: async () => {},
  }) as unknown as SetupState;
const html = (inst: SurfacesInstallRef | null) => renderToStaticMarkup(<ConnectStep state={state(inst)} next={() => {}} />);

describe("ConnectStep disconnect", () => {
  it("shows Disconnect Slack when the install is active", () => {
    expect(html(install("active"))).toContain(`data-testid="setup-disconnect"`);
  });

  it("hides it while the install is pending or absent", () => {
    expect(html(install("pending"))).not.toContain("setup-disconnect");
    expect(html(null)).not.toContain("setup-disconnect");
  });
});

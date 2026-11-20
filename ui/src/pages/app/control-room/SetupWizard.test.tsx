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

/** po-1444: the readiness checklist, and no trip to Slack while Slack can't reach the server. */
describe("ConnectStep readiness", () => {
  const ready = { public_url: null, redirect_url: "https://nest.acme.com/surfaces/slack/oauth/callback", buffer_key: true, model_key: true };
  const withReadiness = (readiness: unknown) => {
    const s = state(null) as any;
    s.status = { ...s.status, readiness };
    s.nests = [{ id: "n1", name: "Ops" }];
    return renderToStaticMarkup(<ConnectStep state={s} next={() => {}} />);
  };

  it("all ready: every line is ready, the redirect URL shows, and Open Slack is enabled", () => {
    const out = withReadiness(ready);
    expect(out).not.toContain(`data-ok="false"`);
    expect(out).toContain("https://nest.acme.com/surfaces/slack/oauth/callback");
    expect(out).not.toContain("setup-url-blocked");
  });

  it("a localhost URL: the fix steps and a Server settings link show, and Open Slack is off", () => {
    const out = withReadiness({
      ...ready,
      public_url: { problem: "The public base URL is http://localhost:3838.", steps: ["Open Server settings → Basic → Public base URL"] },
      buffer_key: false,
    });
    expect(out.match(/data-ok="false"/g)?.length).toBe(2);
    expect(out).toContain("Server settings → Basic → Public base URL");
    expect(out).toContain(`href="/settings"`);
    expect(out).toContain("setup-url-blocked");
    expect(out).not.toContain("setup-redirect-url");
  });
});

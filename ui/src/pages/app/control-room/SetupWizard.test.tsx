/** PO-1436: a connected Slack workspace offers Disconnect; a pending install does not. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectStep, ReadinessChecklist, wrongAddress, type SetupState } from "./SetupWizard";
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

  it("po-1523: self-serve steps run manifest, redirect URL, values, approve", () => {
    const s = state({ id: "i1", surface: "slack", mode: "manifest", status: "pending", home_nest_id: "n1" }) as any;
    s.status = { ...s.status, slack_hosted: false, readiness: ready };
    s.nests = [{ id: "n1", name: "Ops" }];
    const out = renderToStaticMarkup(<ConnectStep state={s} next={() => {}} />);
    const at = ["Download manifest", "setup-redirect-url", "setup-credentials", "Open Slack to approve"].map((t) => out.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("a page opened at another address than the public base URL is flagged", () => {
    expect(wrongAddress(ready, "https://nest.acme.com")).toBeNull();
    expect(wrongAddress(ready, "http://localhost:3838")).toBe("http://localhost:3838");
    expect(wrongAddress(ready, null)).toBeNull();
    const out = renderToStaticMarkup(<ReadinessChecklist readiness={ready} here="http://localhost:3838" />);
    expect(out.match(/data-ok="false"/g)?.length).toBe(1);
    expect(out).toContain("You&#x27;re using this server at http://localhost:3838, but its public base URL is https://nest.acme.com.");
  });
});

/** po-1437: a bound channel says how it is paused and offers Manage. */
describe("bound channel", () => {
  it("names who paused it", async () => {
    const { boundLabel } = await import("./SetupWizard");
    expect(boundLabel({ status: "active" }).text).toBe("Listening");
    expect(boundLabel({ status: "paused_guard", paused_by_admin: true }).text).toBe("Paused by an admin");
    expect(boundLabel({ status: "paused_guard" }).text).toBe("Paused: the reader check failed");
    expect(boundLabel({ status: "paused_by_member" }).text).toBe("Paused: a member removed Nest");
  });

  it("renders the status and a Manage button", async () => {
    const { BindingManage } = await import("./SetupWizard");
    const out = renderToStaticMarkup(
      <BindingManage
        channel={{ id: "C1", name: "ops", is_private: false, is_ext_shared: false, num_members: 3, binding: null }}
        binding={{ id: "b1", nest_id: "n1", status: "paused_guard", paused_by_admin: true }}
        state={state(install("active"))}
        onChanged={() => {}}
      />,
    );
    expect(out).toContain("Paused by an admin");
    expect(out).toContain('aria-label="Manage #ops"');
  });
});

/** po-1437: the history shows the actual person (email), or Nest, with the reason. */
describe("binding history", () => {
  it("lists who, what and why, newest first", async () => {
    const { BindingHistoryList } = await import("./SetupWizard");
    const out = renderToStaticMarkup(
      <BindingHistoryList
        entries={[
          { action: "paused", reason: "launch week", at: "2026-11-23T10:00:00.000Z", by: { user_id: "u1", email: "sam@acme.com", name: "Sam" } },
          { action: "paused", reason: "Paused by Nest: someone who can read the nest isn't in the channel.", at: "2026-11-22T10:00:00.000Z", by: null },
        ]}
      />,
    );
    expect(out).toContain("Sam · sam@acme.com");
    expect(out).toContain("launch week");
    expect(out).toContain("Nest (automatic)");
    expect(out.indexOf("sam@acme.com")).toBeLessThan(out.indexOf("Nest (automatic)"));
    expect(renderToStaticMarkup(<BindingHistoryList entries={[]} />)).toContain("No changes recorded yet.");
  });
});

/** po-1437: the disconnect confirm names every channel that stops, and says members are told. */
describe("disconnect confirm", () => {
  it("lists live channels (not DMs, not removed) and the message each one gets", async () => {
    const { DisconnectChannels } = await import("./SetupWizard");
    const b = (id: string, status: string, kind = "public_channel") => ({ id, install_id: "i1", nest_id: "n1", conversation_id: id, conversation_name: id.toLowerCase(), conversation_kind: kind, status }) as any;
    const out = renderToStaticMarkup(<DisconnectChannels bindings={[b("OPS", "active"), b("SALES", "paused_guard"), b("OLD", "removed"), b("DM1", "active", "dm")]} />);
    expect(out).toContain("These 2 channels stop");
    expect(out).toContain("#ops");
    expect(out).toContain("#sales");
    expect(out).not.toContain("#old");
    expect(out).not.toContain("#dm1");
    expect(out).toContain("Nest posts one message in each");
    expect(renderToStaticMarkup(<DisconnectChannels bindings={[]} />)).toContain("isn&#x27;t listening in any channel");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADMIN_HELP_TOPICS, helpTopic } from "./help-topics";
import { meta as settingsMeta } from "../settings/meta";
import { meta as teammatesMeta } from "../teammates/meta";
import { PAGE_GROUPS } from "../../../lib/pages";

// The in-app Help (How it works) must let an admin find single sign-on, and
// every UI location it names must be one the app actually renders — the SSO
// docs went stale once already when the admin pages moved into the rail.
const adminGroup = PAGE_GROUPS.find((g) => g.id === "admin")!.label;
const settingsSource = readFileSync(
  fileURLToPath(new URL("../settings/page.tsx", import.meta.url)),
  "utf8",
);

describe("in-app help: single sign-on", () => {
  it("registers an SSO topic among the admin help topics", () => {
    expect(ADMIN_HELP_TOPICS.map((t) => t.id)).toContain("sso");
    const sso = helpTopic("sso");
    expect(sso.title).toMatch(/single sign-on/i);
    expect(sso.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("points at the real Admin → Server settings → Single sign-on location", () => {
    const sso = helpTopic("sso");
    expect(sso.where).toBe(`${adminGroup} → ${settingsMeta.label} → Single sign-on`);
    // The tab label must exist on the settings page.
    expect(settingsSource).toContain('label: "Single sign-on"');
  });

  it("names the callback path the server registers and the Teammates page for offboarding", () => {
    const sso = helpTopic("sso");
    const text = [sso.summary, ...sso.steps, ...sso.notes].join("\n");
    expect(text).toContain("/auth/oidc/callback");
    expect(text).toContain(`${adminGroup} → ${teammatesMeta.label}`);
    expect(text).toContain("CONFIGURATION.md");
    // The base-URL card it sends admins to must exist under that name.
    expect(text).toContain("Public base URL");
    expect(settingsSource).toContain("Public base URL");
  });

  it("gives every admin topic a location inside the Admin group", () => {
    for (const t of ADMIN_HELP_TOPICS) {
      expect(t.where.startsWith(`${adminGroup} → `)).toBe(true);
    }
  });
});

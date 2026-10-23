/**
 * Settings → Features → Plugins (community-nest-plugins-page-to-turn-on-github-
 * markdown-sync-from-the-ui): the superadmin's switch for FEATURE_PLUGINS, the
 * allowlist of plugin packages, and what the server actually loaded — read
 * from a mocked GET /admin/settings.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginsSettingsCard, type PluginsSettingsCardProps } from "./PluginsSettingsCard";

const base: PluginsSettingsCardProps = {
  enabled: false,
  packages: "",
  loaded: [],
  loadErrors: [],
  onChange: () => {},
};
const html = (p: Partial<PluginsSettingsCardProps> = {}) => renderToStaticMarkup(<PluginsSettingsCard {...base} {...p} />);

describe("PluginsSettingsCard", () => {
  it("off: the switch is off and the package list is disabled", () => {
    const h = html();
    expect(h).toContain("Plugins");
    expect(h).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(/<input[^>]*id="plugins_packages"[^>]*>/.exec(h)?.[0]).toContain('disabled=""');
    expect(h).toContain("Off");
  });

  it("on: the allowlist is editable and shows its current value", () => {
    const h = html({ enabled: true, packages: "@promptowl/contextnest-plugin-github-markdown" });
    const input = /<input[^>]*id="plugins_packages"[^>]*>/.exec(h)?.[0];
    expect(input).not.toContain('disabled=""');
    expect(input).toContain('value="@promptowl/contextnest-plugin-github-markdown"');
    expect(h).toMatch(/role="switch"[^>]*aria-checked="true"/);
  });

  it("lists what loaded, with version and capabilities", () => {
    const h = html({
      enabled: true,
      loaded: [{ name: "github-markdown", version: "0.1.0", displayName: "GitHub Markdown", capabilities: ["pull", "process"] }],
    });
    expect(h).toContain("GitHub Markdown");
    expect(h).toContain("github-markdown v0.1.0");
    expect(h).toContain("pull, process");
  });

  it("lists every spec that failed to load with the reason", () => {
    const h = html({ enabled: true, loadErrors: [{ spec: "@acme/nope", error: "Cannot find package '@acme/nope'" }] });
    expect(h).toContain("@acme/nope");
    expect(h).toContain("Cannot find package &#x27;@acme/nope&#x27;");
  });

  it("says when the list was edited but not saved yet", () => {
    expect(html({ enabled: true, packages: "a", dirty: true })).toContain("Save to load this list");
  });

  it("shows the server's error for the field", () => {
    expect(html({ enabled: true, packages: "bad spec", error: '"bad spec" is not a package name or module path.' })).toContain(
      "is not a package name or module path.",
    );
  });
});

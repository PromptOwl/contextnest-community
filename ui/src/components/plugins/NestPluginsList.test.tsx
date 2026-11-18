/**
 * The nest Plugins page body, rendered against mocked GET /nests/:id/plugins
 * responses (community-nest-plugins-page-to-turn-on-github-markdown-sync-from-
 * the-ui). One test per acceptance criterion it can show statically: the
 * GitHub plugin and its schema form for an owner, secrets masked and never
 * echoed, run history with counts, editor = run but not configure, viewer =
 * read only.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NestPluginsList, type NestPluginsListProps } from "./NestPluginsList";
import { githubEnabled, githubMarkdown, memoConfigured } from "../../lib/nest-plugins.fixtures";
import type { NestPluginsResponse } from "../../lib/api";

const noop = () => {};
const base: NestPluginsListProps = {
  data: { plugins: [githubMarkdown, memoConfigured], load_errors: [] },
  role: "admin",
  onSave: noop,
  onToggle: noop,
  onRun: noop,
  onRemove: noop,
  onCheckHealth: noop,
};
const html = (p: Partial<NestPluginsListProps> = {}) => renderToStaticMarkup(<NestPluginsList {...base} {...p} />);
/** The markup of one plugin's card, found by its data-plugin attribute. */
const card = (h: string, name: string) => {
  const start = h.indexOf(`data-plugin="${name}"`);
  if (start < 0) return undefined;
  const next = h.indexOf("data-plugin=", start + 12);
  return h.slice(start, next < 0 ? undefined : next);
};
const button = (h: string, label: string) =>
  new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "s").exec(h)?.[0];
const input = (h: string, id: string) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(h)?.[0];

describe("NestPluginsList — owner", () => {
  it("lists GitHub Markdown with a form built from its settings schema", () => {
    const h = card(html(), "github-markdown")!;
    expect(h).toContain("GitHub Markdown");
    expect(h).toContain("v0.1.0");
    for (const label of ["Repository", "Personal access token", "Branch", "Mode", "Path", "Max files"]) expect(h).toContain(label);
    // Required marker and the schema's own help text.
    expect(h).toMatch(/Repository<span[^>]*>\s*\*/);
    expect(h).toContain("Needed for private repos and to lift the anonymous rate limit.");
    // Defaults show as placeholders, not values.
    expect(input(h, "plugin-github-markdown-maxFiles")).toContain('placeholder="500"');
    expect(input(h, "plugin-github-markdown-maxFiles")).toContain('type="number"');
  });

  it("an unconfigured plugin offers Enable (saves and turns it on), no Run now, no Remove", () => {
    const h = card(html(), "github-markdown")!;
    expect(h).toContain("Not set up");
    expect(button(h, "Save and enable")).toBeDefined();
    expect(button(h, "Run now")).toBeUndefined();
    expect(button(h, "Remove")).toBeUndefined();
  });

  it("the token field is a password input and never carries a value", () => {
    const h = html();
    const gh = input(card(h, "github-markdown")!, "plugin-github-markdown-token")!;
    expect(gh).toContain('type="password"');
    expect(gh).toContain('value=""');
    expect(gh).toContain('placeholder="Not set"');
  });

  it("a stored secret shows masked (••••), stays write-only and can be cleared", () => {
    const h = card(html(), "memo")!;
    const token = input(h, "plugin-memo-token")!;
    expect(token).toContain('value=""');
    expect(token).toContain('placeholder="••••"');
    expect(h).toContain("Saved. Type a new value to replace it.");
    expect(button(h, "Clear")).toBeDefined();
    // The plain setting is a normal value.
    expect(input(h, "plugin-memo-prefix")).toContain('value="Memo"');
  });

  it("an enabled plugin: Run now, Save, Remove, the enable switch on, and who it writes as", () => {
    const h = card(html(), "memo")!;
    expect(button(h, "Run now")).toBeDefined();
    expect(button(h, "Run now")).not.toContain('disabled=""');
    expect(button(h, "Save")).toBeDefined();
    expect(button(h, "Remove")).toBeDefined();
    expect(h).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(h).toContain("Plugin: Memo");
    expect(h).toContain("Enabled");
  });

  it("run history: when, who, status and counts", () => {
    const h = card(html(), "memo")!;
    expect(h).toContain("owner@acme.dev");
    expect(h).toContain("3 created · 1 updated · 12 unchanged");
    expect(h).toMatch(/>Clean</);
  });

  it("a failed run shows its error and the items that failed; a conflicted run says edits were kept", () => {
    const h = card(html({ data: { plugins: [githubEnabled], load_errors: [] } }), "github-markdown")!;
    expect(h).toMatch(/>Failed</);
    expect(h).toContain("GitHub returned HTTP 404 listing the main branch tree of PromptOwl/context-nest-spec");
    expect(h).toContain("docs/a.md");
    expect(h).toContain("not an allowed folder");
    expect(h).toMatch(/>Kept local edits</);
    expect(h).toContain("4 created · 0 updated · 9 unchanged · 1 kept (edited here)");
    expect(h).toContain("nodes/engineering/readme");
  });

  it("health: Check connection, then the result", () => {
    expect(button(card(html(), "memo")!, "Check connection")).toBeDefined();
    expect(card(html({ health: { memo: { ok: true } } }), "memo")).toContain("Connection works");
    expect(card(html({ health: { memo: { ok: false, detail: "bad token" } } }), "memo")).toContain("bad token");
  });

  it("a busy run disables Run now and spins", () => {
    const b = button(card(html({ busy: { memo: "run" } }), "memo")!, "Running")!;
    expect(b).toContain('disabled=""');
    expect(b).toContain("animate-spin");
  });

  it("field errors and a server error show on the card", () => {
    const h = card(
      html({ fieldErrors: { "github-markdown": { repo: "Required" } }, errors: { "github-markdown": "github-markdown: repo must look like \"owner/name\"" } }),
      "github-markdown",
    )!;
    expect(h).toContain("Required");
    expect(h).toContain("repo must look like &quot;owner/name&quot;");
  });

  it("plugins that failed to load are listed for the people who can act on them", () => {
    const data: NestPluginsResponse = {
      plugins: [memoConfigured],
      load_errors: [{ spec: "@acme/contextnest-plugin-wiki", error: "Cannot find package" }],
    };
    const h = html({ data });
    expect(h).toContain("@acme/contextnest-plugin-wiki");
    expect(h).toContain("Cannot find package");
  });

  it("no plugins installed: says where a server admin adds them", () => {
    const h = html({ data: { plugins: [], load_errors: [] } });
    expect(h).toContain("No plugins are installed on this server");
    expect(h).toContain("Server settings");
  });
});

describe("NestPluginsList — editor", () => {
  const h = html({ role: "editor" });

  it("can run an enabled plugin", () => {
    expect(button(card(h, "memo")!, "Run now")).toBeDefined();
    expect(button(card(h, "memo")!, "Run now")).not.toContain('disabled=""');
  });

  it("cannot configure: no Save, Remove or Enable; inputs and the switch are disabled", () => {
    for (const name of ["memo", "github-markdown"]) {
      const c = card(h, name)!;
      expect(button(c, "Save")).toBeUndefined();
      expect(button(c, "Remove")).toBeUndefined();
      expect(button(c, "Clear")).toBeUndefined();
    }
    expect(input(card(h, "memo")!, "plugin-memo-prefix")).toContain('disabled=""');
    expect(card(h, "memo")).toMatch(/role="switch"[^>]*disabled=""/);
    expect(h).toContain("Only nest owners and admins change plugin settings.");
  });

  it("still sees that a secret is set, masked", () => {
    expect(input(card(h, "memo")!, "plugin-memo-token")).toContain('placeholder="••••"');
  });
});

describe("NestPluginsList — viewer", () => {
  const h = html({ role: "viewer" });

  it("reads: plugins, settings and run history are shown", () => {
    expect(h).toContain("GitHub Markdown");
    expect(h).toContain("3 created · 1 updated · 12 unchanged");
  });

  it("cannot run or configure", () => {
    const c = card(h, "memo")!;
    expect(button(c, "Run now")).toBeUndefined();
    expect(button(c, "Save")).toBeUndefined();
    expect(button(c, "Check connection")).toBeDefined();
    expect(h).toContain("You can see what is connected.");
  });
});

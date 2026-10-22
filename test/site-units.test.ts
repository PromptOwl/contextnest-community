/** CU-wdqcq05jhm: small units of the public docs site. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { PRIVATE_HOST, isPublicHost } from "../src/site/indexnow.js";
import { config } from "../src/config.js";
import { renderMarkdown, rewriteDocumentLinks, describe as describeBody } from "../src/site/markdown.js";
import { tagTitle } from "../src/site/render.js";

describe("DOCS_SITES parsing", () => {
  const savedBase = process.env.PUBLIC_BASE_URL;
  afterEach(() => {
    delete process.env.DOCS_SITES;
    if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedBase;
  });
  it("ignores, with a warning, an entry for this server's own host", () => {
    process.env.PUBLIC_BASE_URL = "https://nest.example.com";
    process.env.DOCS_SITES = "Nest.Example.com=self, nest.example.com.:443=self2, docs.example.com=n1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...config.DOCS_SITES]).toEqual([["docs.example.com", "n1"]]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  it("warns that it can't catch this server's own host when PUBLIC_BASE_URL is unset", () => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.DOCS_SITES = "docs.example.com=n1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...config.DOCS_SITES]).toEqual([["docs.example.com", "n1"]]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PUBLIC_BASE_URL is not/));
    warn.mockRestore();
  });
  it("splits each pair on the first = only, and skips pairs without one", () => {
    process.env.PUBLIC_BASE_URL = "https://nest.example.com";
    process.env.DOCS_SITES = " Docs.Example.com = id=with=equals , broken, b.example=2";
    expect([...config.DOCS_SITES]).toEqual([
      ["docs.example.com", "id=with=equals"],
      ["b.example", "2"],
    ]);
  });
});

describe("IndexNow private-host check", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.1", "169.254.1.1", "[::1]", "wiki.corp.local", "docs.internal", "nas.lan", "box.home.arpa"])(
    "treats %s as private",
    (host) => expect(PRIVATE_HOST.test(host)).toBe(true),
  );
  it.each([
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:a00:1]/",
    "https://8.8.8.8/",
    "https://[2001:4860::8888]/",
    "https://0x7f000001/",
    "https://site-origin.invalid/d/x",
    "https://wiki.corp.local/",
    "https://localhost/",
  ])("isPublicHost refuses %s", (u) => expect(isPublicHost(new URL(u))).toBe(false));
  it.each(["https://docs.acme.dev/", "https://nest.promptowl.ai/d/docs"])("isPublicHost accepts %s", (u) =>
    expect(isPublicHost(new URL(u))).toBe(true),
  );
  it.each(["docs.example.com", "172.32.0.1", "172.15.0.1", "local.example.com", "internal.example.com"])(
    "treats %s as public",
    (host) => expect(PRIVATE_HOST.test(host)).toBe(false),
  );
});

// CU-wdqcq05raw: rendering bugs found on the live docs site.
describe("docs site Markdown rendering", () => {
  const pages: Record<string, string> = { "nodes/a": "/d/s/a", a: "/d/s/a" };
  const resolve = (t: string) => (pages[t] ? { href: pages[t], nodeId: "nodes/a" } : null);
  const html = (body: string) => renderMarkdown(body, { resolve }).html;

  it("doesn't turn bare filenames or schemeless hosts into links, but keeps real URLs", () => {
    const out = html("Edit CONTEXT.md and API.md, then open claude.ai/Desktop/ChatGPT or https://example.com/x.");
    expect(out).not.toContain("http://CONTEXT.md");
    expect(out).not.toContain("http://API.md");
    expect(out).not.toContain('href="http://claude.ai');
    expect(out).toContain('<a href="https://example.com/x" rel="noopener">https://example.com/x</a>');
  });

  it("renders an aliased wikilink inside a table cell without splitting the row", () => {
    const out = html("| Page | Note |\n| --- | --- |\n| [[nodes/a|The A page]] | x |\n| [[nodes/missing|Gone]] | y |");
    expect(out).toContain('<td><a href="/d/s/a">The A page</a></td>');
    expect(out).toContain("<td>Gone</td>");
    expect(out).not.toContain("[[");
    expect(out.match(/<td>/g)?.length).toBe(4);
  });

  it("keeps wikilinks in code spans and fences as written, in tables too", () => {
    const out = html("| a | b |\n| --- | --- |\n| `[[nodes/a]]` | x |\n\n```\n[[nodes/a|z]]\n```");
    expect(out).toContain("<code>[[nodes/a]]</code>");
    expect(out).toContain("[[nodes/a|z]]\n</code>");
  });

  it("strips HTML comments outside code from the HTML, the Markdown twin and the description", () => {
    const body = "<!-- editor note: secret -->\n\nVisible text. <!-- inline -->More.\n\n`<!-- in code -->`\n\n```\n<!-- in fence -->\n```";
    const out = html(body);
    expect(out).not.toContain("editor note");
    expect(out).toContain("<p>Visible text. More.</p>");
    expect(out).not.toContain("inline");
    expect(out).toContain("<code>&lt;!-- in code --&gt;</code>");
    expect(out).toContain("&lt;!-- in fence --&gt;");
    const twin = rewriteDocumentLinks(body, () => null);
    expect(twin).not.toContain("editor note");
    expect(twin).not.toContain("inline");
    expect(twin).toContain("`<!-- in code -->`");
    expect(twin).toContain("<!-- in fence -->");
    // A comment that quotes code is still one comment (review finding).
    const tricky = "Before <!-- TODO: rename `foo` before launch --> after.\n\n<!--\n```\nold\n```\n-->\n\nEnd.";
    for (const out of [html(tricky), rewriteDocumentLinks(tricky, () => null), describeBody(tricky)]) {
      expect(out).not.toContain("TODO");
      expect(out).not.toContain("old");
      expect(out).not.toContain("--&gt;");
      expect(out).not.toContain("-->");
    }
    expect(describeBody("Lead <!-- hidden --> sentence that is long enough to stand as the description of this page.")).not.toContain("hidden");
  });
});

describe("docs site tag hub titles", () => {
  it.each([
    ["mcp", "MCP"],
    ["api-design", "API Design"],
    ["ai_agents", "AI Agents"],
    ["cli", "CLI"],
    ["sso", "SSO"],
    ["sdk", "SDK"],
    ["getting-started", "Getting Started"],
    ["governance", "Governance"],
    ["apis", "APIs"],
    ["llms-txt", "LLMs Txt"],
    ["rest", "Rest"],
    ["--", "--"],
  ])("%s → %s", (tag, title) => {
    expect(tagTitle(tag)).toBe(title);
  });
});

/**
 * Pure render tests for the structured governance email — no SMTP/db, just the
 * subject/text/html shaping and, importantly, that user fragments are escaped.
 */
import { describe, it, expect } from "vitest";
import { renderEmail, renderHtml } from "../src/notify/email-render.js";

describe("renderEmail", () => {
  it("renders an approved event with title, details, and a link button", () => {
    const { subject, text, html } = renderEmail({
      status: "approved",
      docTitle: "API limits",
      path: "Marketing / API",
      actor: "reviewer@acme.com",
      version: 3,
      note: "looks good",
      link: "https://nest.acme.com/?nest=n1&doc=nodes/api",
    });
    expect(subject).toBe("API limits is approved");
    // Plain-text body has the sentence + labelled details, no markup chars.
    expect(text).toContain("has been approved by reviewer@acme.com");
    expect(text).toContain("Path: Marketing / API");
    expect(text).toContain("Version: v3");
    expect(text).toContain("Regards,");
    // HTML: heading, bold title, status badge, and the open-document button.
    expect(html).toContain("API limits is approved");
    expect(html).toContain("<strong>API limits</strong>");
    expect(html).toContain("Approved");
    // & is escaped to &amp; in the href attribute (valid HTML; browsers decode).
    expect(html).toContain(
      'href="https://nest.acme.com/?nest=n1&amp;doc=nodes/api"',
    );
    expect(html).toContain(">Open document<");
  });

  it("omits the button and version row when link/version are absent", () => {
    const { html } = renderEmail({
      status: "pending_review",
      docTitle: "Doc",
      path: "Nest",
      actor: "a@b.com",
      version: null,
      link: "",
    });
    expect(html).not.toContain("Open document");
    expect(html).not.toContain(">Version<");
    expect(html).toContain("A review has been requested");
  });

  it("renders a share event in the third person with the permission", () => {
    const { subject, text, html } = renderEmail({
      status: "shared",
      docTitle: "Marketing",
      path: "Marketing",
      actor: "new@acme.com",
      permission: "write",
      by: "owner@acme.com",
      link: "https://nest.acme.com/?nest=n1",
    });
    expect(subject).toBe("New collaborator on Marketing");
    expect(text).toContain("new@acme.com was added to Marketing as write");
    expect(html).toContain("<strong>write</strong>");
    expect(html).toContain(">Open nest<");
  });

  it("escapes HTML in every user-controlled fragment", () => {
    const { html } = renderEmail({
      status: "rejected",
      docTitle: '<img src=x onerror=alert(1)>',
      path: "<b>nest</b>",
      actor: "<script>@x.com",
      note: '"><svg onload=alert(1)>',
      version: 1,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img");
  });

  it("strips CR/LF from the subject (no header injection)", () => {
    const { subject } = renderEmail({
      status: "approved",
      docTitle: "Doc\r\nBcc: attacker@evil.com",
      path: "Nest",
      version: 1,
    });
    expect(subject).not.toContain("\n");
    expect(subject).not.toContain("\r");
  });
});

describe("renderHtml (fallback path — burst digests)", () => {
  it("keeps a multi-line digest's line breaks as <br>", () => {
    // A burst digest routes through the fallback (no structured details), so
    // its newlines must survive as <br> or the HTML body collapses to one line.
    const digest = "3 updates:\n• a@x.com\n• b@x.com\n• c@x.com";
    const html = renderHtml(digest, "Team Nest");
    expect(html.match(/<br>/g)?.length).toBe(3);
    expect(html).toContain("3 updates:<br>");
    expect(html).toContain("• a@x.com<br>• b@x.com");
  });

  it("still escapes user fragments before inserting <br> (no injection)", () => {
    const html = renderHtml("line1\n<img src=x onerror=alert(1)>", "Nest");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("line1<br>");
  });
});

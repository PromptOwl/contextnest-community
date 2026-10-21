/** CU-wdqcq05jhm: the DNS verification states of the public site dialog. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteDnsPanel, type SiteDnsPanelProps } from "./SiteDnsPanel";

const base: SiteDnsPanelProps = {
  host: "docs.acme.dev",
  verified: false,
  intro: "Add these records at your DNS provider:",
  records: [
    { type: "TXT", name: "_contextnest.docs.acme.dev", value: "contextnest-site=abc" },
    { type: "CNAME", name: "docs.acme.dev", value: "sites.example.com" },
  ],
  busy: false,
  verifying: false,
  onVerify: () => {},
};
const html = (p: Partial<SiteDnsPanelProps> = {}) => renderToStaticMarkup(<SiteDnsPanel {...base} {...p} />);
const verifyButton = (h: string) => /<button[^>]*>(?:(?!<\/button>).)*Verify DNS<\/button>/s.exec(h)?.[0];

describe("SiteDnsPanel", () => {
  it("unverified: badge, both records and an enabled Verify DNS button", () => {
    const h = html();
    expect(h).toContain("Not verified yet");
    expect(h).toContain("_contextnest.docs.acme.dev");
    expect(h).toContain("contextnest-site=abc");
    expect(h).toContain("sites.example.com");
    expect(verifyButton(h)).toBeDefined();
    expect(verifyButton(h)).not.toContain(`disabled=""`);
  });

  it("verified: Verified badge, records still listed, no Verify DNS button", () => {
    const h = html({ verified: true });
    expect(h).toContain("Verified");
    expect(h).not.toContain("Not verified yet");
    expect(h).toContain("_contextnest.docs.acme.dev");
    expect(verifyButton(h)).toBeUndefined();
  });

  it("while a request runs: Verify DNS is disabled, with a spinner when it is the verify", () => {
    expect(verifyButton(html({ busy: true }))).toContain(`disabled=""`);
    expect(verifyButton(html({ busy: true, verifying: true }))).toContain("animate-spin");
    expect(verifyButton(html({ busy: true }))).not.toContain("animate-spin");
  });

  it("shows the note when there is no CNAME target", () => {
    const h = html({ records: [base.records[0]], note: "Ask your server admin for the CNAME target." });
    expect(h).toContain("Ask your server admin for the CNAME target.");
    expect(h).not.toContain("CNAME</span>");
  });
});

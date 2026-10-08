import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { bannerHeading } from "../src/shared/startup-banner.js";

const pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

describe("startup banner", () => {
  it("shows the real package version, not a hard-coded one", () => {
    expect(bannerHeading()).toBe(`ContextNest Community Server v${pkgVersion}`);
    expect(bannerHeading()).not.toContain("v0.1.0");
  });
});

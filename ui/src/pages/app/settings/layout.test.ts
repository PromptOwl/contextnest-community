import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const tabsList = page.match(/<TabsList[^>]*>/)?.[0] ?? "";

describe("Server settings layout", () => {
  it("po-1433: the tab row wraps instead of running past the page", () => {
    expect(tabsList).toContain("flex-wrap");
    expect(tabsList).toContain("h-auto");
  });
});

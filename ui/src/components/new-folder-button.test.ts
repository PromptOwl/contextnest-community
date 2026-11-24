import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("po-1169: the New Folder button takes the same text color as the other outline actions", () => {
  const view = readFileSync(fileURLToPath(new URL("./NestView.tsx", import.meta.url)), "utf8");
  const label = view.indexOf('aria-label="New Folder"');
  expect(label).toBeGreaterThan(0);
  const tag = view.slice(view.lastIndexOf("<Button", label), label);
  expect(tag).toContain('variant="outline"');
  expect(tag).not.toMatch(/className="[^"]*\btext-/);
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
/** The opening tag (and what leads up to it) of the element carrying a test id. */
const before = (file: string, testId: string) => {
  const s = src(file);
  const at = s.indexOf(`data-testid="${testId}"`);
  expect(at, testId).toBeGreaterThan(0);
  return s.slice(at - 900, at);
};
const HIDDEN_BUT_TAKING_SPACE = /(?<![\w-])(invisible|opacity-0)(?![\w-])/;

describe("no empty space is kept for hidden editing controls", () => {
  it("po-1240: the formatting toolbar never hides while keeping its height above the body", () => {
    expect(before("./MarkdownEditor.tsx", "markdown-editor-toolbar")).not.toMatch(HIDDEN_BUT_TAKING_SPACE);
    expect(src("./MarkdownEditor.tsx")).not.toContain("toolbarHidden");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
// @ts-expect-error -- plain JS config
import config from "../../tailwind.config.js";

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = async (raw: string) =>
  (await postcss([tailwindcss({ ...config, content: [{ raw }] })]).process("@tailwind utilities;", { from: undefined })).css;

describe("po-1454: the top bar answers to its own width", () => {
  it("bar-* variants compile to container queries on the top bar", async () => {
    expect(await css("bar-md:inline")).toMatch(/@container topbar \(min-width: 64rem\)/);
    expect(await css("bar-max-xl:hidden")).toMatch(/@container topbar \(max-width: calc\(86rem - 0?\.02px\)\)/);
  });
  it("the header row is that container", () => {
    expect(src("../App.tsx")).toContain("[container:topbar/inline-size]");
  });
  it("no bar label is switched by the window's width, which counts the sidebar too", () => {
    for (const file of ["../components/HeaderRibbon.tsx", "../components/TopBarTools.tsx"]) {
      expect(src(file)).not.toMatch(/(?<![\w-])(sm|md|lg|xl|2xl):inline/);
    }
  });
});

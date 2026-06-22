import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { "lib/core/index": "src/lib/core/index.ts" },
    format: "esm",
    dts: true,
    outDir: "dist",
  },
]);

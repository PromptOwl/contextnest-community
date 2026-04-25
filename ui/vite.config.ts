import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  css: {
    postcss: resolve(__dirname, "postcss.config.js"),
  },
  build: {
    outDir: resolve(__dirname, "../dist/web3"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/auth": "http://localhost:3838",
      "/nests": "http://localhost:3838",
      "/health": "http://localhost:3838",
    },
  },
});

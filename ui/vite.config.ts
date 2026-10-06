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
      "/license": "http://localhost:3838",
      // Published documents are server-rendered, not SPA routes — without this
      // /p/<slug> resolves to the app shell in dev.
      "/p": "http://localhost:3838",
      "/nests": "http://localhost:3838",
      "/health": "http://localhost:3838",
    },
  },
});

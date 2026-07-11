import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

import { rm } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const maruRoot = resolve("d:\\projects\\Maru");

export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    {
      name: "cleanup-desktop-dist",
      closeBundle: async () => {
        const distPath = resolve(__dirname, "desktop-web-dist");
        const removeDirs = ["downloads", "nanami-dump"];
        for (const dir of removeDirs) {
          try {
            await rm(resolve(distPath, dir), { recursive: true, force: true });
            console.log(`[cleanup] Removed unnecessary bundle folder: ${dir}`);
          } catch (err) {
            console.error(`[cleanup] Failed to remove ${dir}:`, err);
          }
        }
      }
    }
  ],
  base: "./",
  resolve: {
    alias: [
      { find: /^\.\.\/pages\//, replacement: resolve(maruRoot, "src/pages/") + "/" },
      { find: /^\.\.\/index\.css$/, replacement: resolve(maruRoot, "src/index.css") },
      { find: /^\.\.\/App\.css$/, replacement: resolve(maruRoot, "src/App.css") },
    ],
  },
  build: {
    outDir: "desktop-web-dist",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        desktopShell: resolve(__dirname, "desktop-shell.html"),
      },
    },
  },
});

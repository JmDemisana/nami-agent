import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const maruRoot = resolve("C:\\Users\\jmdem\\Maru");

export default defineConfig({
  root: __dirname,
  plugins: [react()],
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

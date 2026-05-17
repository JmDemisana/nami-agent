import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const sourcePath = resolve(projectRoot, "tauri-launcher.html");
const targetDir = resolve(projectRoot, "desktop-web-dist");
const targetPath = resolve(targetDir, "tauri-launcher.html");

await mkdir(targetDir, { recursive: true });
await copyFile(sourcePath, targetPath);

console.log(`Prepared ${targetPath}`);

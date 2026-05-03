#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const require = createRequire(resolve(webRoot, "package.json"));

const SOURCES = [
  {
    name: "maki",
    iconsDir: dirname(require.resolve("@mapbox/maki/package.json")) + "/icons",
  },
  {
    name: "temaki",
    iconsDir: dirname(require.resolve("@rapideditor/temaki/package.json")) + "/icons",
  },
];

const destBase = join(webRoot, "public", "icons");

for (const { name, iconsDir } of SOURCES) {
  if (!existsSync(iconsDir)) {
    console.error(`[copy-preset-icons] missing source dir for ${name}: ${iconsDir}`);
    process.exit(1);
  }
  const dest = join(destBase, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(iconsDir, dest, { recursive: true });
  const count = readdirSync(dest).filter((f) => f.endsWith(".svg")).length;
  console.log(`[copy-preset-icons] ${name}: copied ${count} svgs to ${dest}`);
}

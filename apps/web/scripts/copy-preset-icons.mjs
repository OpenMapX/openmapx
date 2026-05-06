#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const require = createRequire(resolve(webRoot, "package.json"));

const SOURCES = [
  {
    name: "maki",
    iconsDir: `${dirname(require.resolve("@mapbox/maki/package.json"))}/icons`,
  },
  {
    name: "temaki",
    iconsDir: `${dirname(require.resolve("@rapideditor/temaki/package.json"))}/icons`,
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

const weatherCodesPath = resolve(webRoot, "../../packages/core/src/utils/weatherCodes.ts");
const meteoconsPath = require.resolve("@iconify-json/meteocons/icons.json");
const weatherIconOutputPath = join(webRoot, "src", "components", "weather", "meteocons.json");

const weatherCodes = readFileSync(weatherCodesPath, "utf8");
const weatherIconNames = [
  ...new Set(
    [...weatherCodes.matchAll(/(?:dayIcon|nightIcon): "([^"]+)"/g)].map((match) => match[1]),
  ),
].sort();
const meteocons = JSON.parse(readFileSync(meteoconsPath, "utf8"));
const missingWeatherIcons = weatherIconNames.filter((name) => !meteocons.icons?.[name]);

if (missingWeatherIcons.length > 0) {
  console.error(`[copy-preset-icons] missing meteocons: ${missingWeatherIcons.join(", ")}`);
  process.exit(1);
}

const weatherIconSubset = {
  prefix: meteocons.prefix,
  width: meteocons.width,
  height: meteocons.height,
  icons: Object.fromEntries(weatherIconNames.map((name) => [name, meteocons.icons[name]])),
};

writeFileSync(weatherIconOutputPath, `${JSON.stringify(weatherIconSubset, null, 2)}\n`);
console.log(
  `[copy-preset-icons] meteocons: wrote ${weatherIconNames.length} icons to ${weatherIconOutputPath}`,
);

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { poiIconGroups } from "./poi-icon-registry.mjs";

const styleDir = resolve(import.meta.dirname, "../public/styles");
const iconDir = resolve(import.meta.dirname, "../node_modules");
// Preserve the original sprite as input; repeatedly compositing a generated PNG rounds alpha edges.
const assetDir = resolve(import.meta.dirname, "assets");
const baseWidth = 358;
const baseHeight = 207;
const badgeSize = 23;
const cellSize = 24;

const badges = [];
const seenNames = new Set();
for (const group of poiIconGroups) {
  for (const [key, source] of Object.entries(group.icons)) {
    if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)?$/.test(key)) {
      throw new Error(`Invalid POI key: ${key}`);
    }
    const name = `poi-${key.replace("/", "-")}`;
    if (seenNames.has(name)) throw new Error(`Duplicate POI sprite: ${name}`);
    seenNames.add(name);
    const [library, icon] = source.split(":");
    if (!(["maki", "temaki"].includes(library) && icon)) {
      throw new Error(`Invalid icon source for ${name}: ${source}`);
    }
    badges.push({ name, library, icon, colour: group.colour });
  }
}

async function renderBadge(library, icon, colour, scale) {
  const iconPath = resolve(
    iconDir,
    library === "maki" ? "@mapbox/maki/icons" : "@rapideditor/temaki/icons",
    `${icon}.svg`,
  );
  const glyph = await sharp(await readFile(iconPath))
    .resize(13 * scale, 13 * scale, { fit: "contain" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const whiteGlyph = Buffer.from(glyph.data);
  for (let offset = 0; offset < whiteGlyph.length; offset += glyph.info.channels) {
    whiteGlyph[offset] = 255;
    whiteGlyph[offset + 1] = 255;
    whiteGlyph[offset + 2] = 255;
  }
  const size = badgeSize * scale;
  const circle = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - scale}" fill="${colour}" stroke="#ffffff" stroke-width="${scale}"/></svg>`,
  );
  return sharp(circle)
    .composite([
      {
        input: whiteGlyph,
        raw: { width: glyph.info.width, height: glyph.info.height, channels: glyph.info.channels },
        left: Math.floor((size - glyph.info.width) / 2),
        top: Math.floor((size - glyph.info.height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function generate(scale) {
  const suffix = scale === 2 ? "@2x" : "";
  const manifestPath = resolve(styleDir, `sprite${suffix}.json`);
  const imagePath = resolve(styleDir, `sprite${suffix}.png`);
  const manifest = JSON.parse(
    await readFile(resolve(assetDir, `basemap-sprite-base${suffix}.json`), "utf8"),
  );
  for (const [name, entry] of Object.entries(manifest)) {
    if (entry.x + entry.width > baseWidth * scale || entry.y + entry.height > baseHeight * scale) {
      throw new Error(`${name} extends beyond the original ${suffix || "1x"} sprite area`);
    }
  }
  const base = await readFile(resolve(assetDir, `basemap-sprite-base${suffix}.png`));
  const baseInfo = await sharp(base).metadata();
  if (baseInfo.width !== baseWidth * scale || baseInfo.height !== baseHeight * scale) {
    throw new Error(`Unexpected ${suffix || "1x"} base sprite dimensions`);
  }
  const columns = Math.floor(baseWidth / cellSize);
  const uniqueArtwork = new Map();
  for (const badge of badges) {
    const signature = `${badge.library}:${badge.icon}:${badge.colour}`;
    if (!uniqueArtwork.has(signature)) uniqueArtwork.set(signature, badge);
  }
  const height = (baseHeight + Math.ceil(uniqueArtwork.size / columns) * cellSize) * scale;
  const layers = [{ input: base, left: 0, top: 0 }];
  const entriesByArtwork = new Map();
  for (const [index, [signature, badge]] of [...uniqueArtwork].entries()) {
    const x = (index % columns) * cellSize * scale;
    const y = (baseHeight + Math.floor(index / columns) * cellSize) * scale;
    layers.push({
      input: await renderBadge(badge.library, badge.icon, badge.colour, scale),
      left: x,
      top: y,
    });
    entriesByArtwork.set(signature, {
      x,
      y,
      width: badgeSize * scale,
      height: badgeSize * scale,
      pixelRatio: scale,
    });
  }
  for (const badge of badges) {
    manifest[badge.name] = entriesByArtwork.get(`${badge.library}:${badge.icon}:${badge.colour}`);
  }
  const atlas = await sharp({
    create: { width: baseWidth * scale, height, channels: 4, background: "#00000000" },
  })
    .composite(layers)
    .png()
    .toBuffer();
  await writeFile(imagePath, atlas);
  const entries = Object.entries(manifest).map(
    ([name, entry]) =>
      `  ${JSON.stringify(name)}: { ${Object.entries(entry)
        .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
        .join(", ")} }`,
  );
  await writeFile(manifestPath, `{\n${entries.join(",\n")}\n}\n`);
  execFileSync("npx", ["biome", "format", "--write", manifestPath], { stdio: "ignore" });
}

await generate(1);
await generate(2);

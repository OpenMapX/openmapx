import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export interface StyleAssetUrls {
  fonts: string;
  sprites: string;
  styles: { id: string; url: string }[];
}

export function resolveStyleAssetUrls(): StyleAssetUrls {
  return {
    fonts: "https://github.com/openmaptiles/fonts/releases/latest/download/v2.0.zip",
    sprites:
      "https://github.com/openmaptiles/osm-bright-gl-style/releases/latest/download/sprite.zip",
    styles: [
      { id: "osm-bright", url: "https://api.maptiler.com/maps/openstreetmap/style.json" },
      { id: "positron", url: "https://api.maptiler.com/maps/positron/style.json" },
      { id: "dark-matter", url: "https://api.maptiler.com/maps/darkmatter/style.json" },
    ],
  };
}

export interface DownloadStyleOptions {
  dataDir: string;
  store: StateStore;
}

export async function downloadStyle(opts: DownloadStyleOptions): Promise<void> {
  // Asset families live at top-level paths under data/ so they don't collide
  // with any consumer service's data dir (e.g. `data/tileserver/` is the
  // tileserver consumer's hardlink target dir).
  const fontsDir = join(opts.dataDir, "tile-fonts");
  const spritesDir = join(opts.dataDir, "tile-sprites");
  const stylesDir = join(opts.dataDir, "tile-styles");
  mkdirSync(fontsDir, { recursive: true });
  mkdirSync(spritesDir, { recursive: true });
  mkdirSync(stylesDir, { recursive: true });

  const urls = resolveStyleAssetUrls();

  const fontsZip = join(opts.dataDir, "tile-fonts.zip");
  await curlAtomic(urls.fonts, fontsZip);
  await execa("unzip", ["-qo", fontsZip, "-d", fontsDir], { stdio: "inherit" });
  opts.store.upsert({
    type: "tile-fonts",
    id: "openmaptiles-v2",
    url: urls.fonts,
    sizeBytes: statSync(fontsZip).size,
    downloadedAt: new Date().toISOString(),
    path: fontsDir,
  });

  const spritesZip = join(opts.dataDir, "tile-sprites.zip");
  await curlAtomic(urls.sprites, spritesZip);
  await execa("unzip", ["-qo", spritesZip, "-d", spritesDir], { stdio: "inherit" });
}

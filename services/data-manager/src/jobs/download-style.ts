import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { StateStore } from "../state.js";

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
  const targetDir = join(opts.dataDir, "tileserver");
  mkdirSync(join(targetDir, "fonts"), { recursive: true });
  mkdirSync(join(targetDir, "styles"), { recursive: true });
  mkdirSync(join(targetDir, "sprites"), { recursive: true });

  const urls = resolveStyleAssetUrls();

  await execa("curl", ["-fSL", "-o", join(targetDir, "fonts.zip"), urls.fonts], {
    stdio: "inherit",
  });
  await execa("unzip", ["-qo", join(targetDir, "fonts.zip"), "-d", join(targetDir, "fonts")], {
    stdio: "inherit",
  });
  opts.store.upsert({
    type: "tile-fonts",
    id: "openmaptiles-v2",
    url: urls.fonts,
    sizeBytes: statSync(join(targetDir, "fonts.zip")).size,
    downloadedAt: new Date().toISOString(),
    path: join(targetDir, "fonts"),
  });

  await execa("curl", ["-fSL", "-o", join(targetDir, "sprites.zip"), urls.sprites], {
    stdio: "inherit",
  });
  await execa("unzip", ["-qo", join(targetDir, "sprites.zip"), "-d", join(targetDir, "sprites")], {
    stdio: "inherit",
  });
}

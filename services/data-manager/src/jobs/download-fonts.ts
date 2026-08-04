import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export const DEFAULT_OPENMAPTILES_FONTS_URL =
  "https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip";

export function resolveFontAssetUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENMAPTILES_FONTS_URL?.trim() || DEFAULT_OPENMAPTILES_FONTS_URL;
}

export function validateFontArchiveEntries(entries: string[]): void {
  if (entries.length === 0) throw new Error("font archive is empty");
  for (const entry of entries) {
    const parts = entry.split("/").filter(Boolean);
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      parts.length === 0 ||
      parts.some((part) => part === "." || part === "..")
    ) {
      throw new Error(`font archive contains an unsafe path: ${entry}`);
    }
  }
}

function containsGlyphPbf(root: string): boolean {
  let found = false;
  for (const font of readdirSync(root, { withFileTypes: true })) {
    if (font.isSymbolicLink()) throw new Error("font archive contains a symbolic link");
    if (!font.isDirectory()) continue;
    for (const entry of readdirSync(join(root, font.name), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("font archive contains a symbolic link");
      if (entry.isFile() && /^\d+-\d+\.pbf$/.test(entry.name)) found = true;
    }
  }
  return found;
}

export interface DownloadFontsOptions {
  dataDir: string;
  store: StateStore;
}

/** Download and atomically replace the glyph tree used online and by offline packages. */
export async function downloadFonts(opts: DownloadFontsOptions): Promise<void> {
  mkdirSync(opts.dataDir, { recursive: true });
  const url = resolveFontAssetUrl();
  const fontsDir = join(opts.dataDir, "tile-fonts");
  const stagingRoot = mkdtempSync(join(opts.dataDir, ".tile-fonts-"));
  const stagingFonts = join(stagingRoot, "fonts");
  const fontsZip = join(stagingRoot, "fonts.zip");
  const backup = join(stagingRoot, "previous");
  let previousMoved = false;
  let installedNew = false;
  try {
    await curlAtomic(url, fontsZip);
    const archive = await execa("unzip", ["-Z1", fontsZip]);
    validateFontArchiveEntries(archive.stdout.split("\n").filter(Boolean));
    await execa("unzip", ["-qo", fontsZip, "-d", stagingFonts], { stdio: "inherit" });
    if (!containsGlyphPbf(stagingFonts))
      throw new Error("font archive contains no glyph PBF files");
    const sizeBytes = statSync(fontsZip).size;

    if (existsSync(fontsDir)) {
      renameSync(fontsDir, backup);
      previousMoved = true;
    }
    renameSync(stagingFonts, fontsDir);
    installedNew = true;
    opts.store.upsert({
      type: "tile-fonts",
      id: "openmaptiles-v2",
      url,
      sizeBytes,
      downloadedAt: new Date().toISOString(),
      path: fontsDir,
    });
    const removeBackup = previousMoved;
    previousMoved = false;
    installedNew = false;
    if (removeBackup) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (installedNew && existsSync(fontsDir)) rmSync(fontsDir, { recursive: true, force: true });
    if (previousMoved && existsSync(backup)) renameSync(backup, fontsDir);
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

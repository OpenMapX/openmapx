import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { StateStore } from "../state.js";
import { curlAtomic } from "./atomic-download.js";

export interface StyleEntry {
  /** Style slug — becomes the subdirectory name under `tile-styles/`. */
  id: string;
  /** GitHub `<owner>/<repo>`, used for both raw style.json and sprite GH-Pages base URL. */
  repo: string;
  /** Branch to pull `style.json` from. */
  branch: string;
  /**
   * Base name / path of the sprite files on the repo's GH Pages deployment,
   * relative to `https://<owner>.github.io/<repo>/`. Most styles put them at
   * the root (`sprite`), but osm-liberty puts them at `sprites/osm-liberty`.
   * We'll fetch `<basePath>.json`, `<basePath>.png`, `<basePath>@2x.{json,png}`
   * and save them locally as `sprite.{json,png}` / `sprite@2x.{json,png}`.
   */
  spritePath?: string;
}

export interface StyleAssetUrls {
  fonts: string;
  styles: StyleEntry[];
}

export function resolveStyleAssetUrls(): StyleAssetUrls {
  return {
    // openmaptiles/fonts — pre-built PBF glyph stacks (Metropolis, Noto Sans,
    // Open Sans, etc.) that tileserver-gl serves at /fonts/<stack>/<range>.pbf.
    fonts: "https://github.com/openmaptiles/fonts/releases/latest/download/v2.0.zip",
    // Per-style fetch: style.json from raw GitHub + sprite.{json,png}(@2x)
    // from the style repo's GitHub Pages deployment. Matches the historical
    // `infra/docker/manage.sh` behaviour — there is no release-asset zip with
    // sprites, and tileserver-gl expects `styles/<name>/style.json` alongside
    // the matching `sprite.*` files in the same folder.
    styles: [
      { id: "osm-bright", repo: "openmaptiles/osm-bright-gl-style", branch: "master" },
      { id: "dark-matter", repo: "openmaptiles/dark-matter-gl-style", branch: "master" },
      { id: "positron", repo: "openmaptiles/positron-gl-style", branch: "master" },
      {
        id: "osm-liberty",
        repo: "maputnik/osm-liberty",
        branch: "gh-pages",
        spritePath: "sprites/osm-liberty",
      },
    ],
  };
}

const SPRITE_SUFFIXES = [".json", ".png", "@2x.json", "@2x.png"];

export interface DownloadStyleOptions {
  dataDir: string;
  store: StateStore;
}

/**
 * Rewrite a fetched MapLibre style so tileserver-gl serves it from local
 * resources instead of MapTiler Cloud / GitHub Pages:
 *
 *   - every `sources[].type === "vector"` → `{ type: "vector", url: "mbtiles://{openmapx}" }`
 *     (tileserver-gl resolves `{openmapx}` to the MBTiles data source in
 *     `config.json`'s `data` block)
 *   - `glyphs = "{fontstack}/{range}.pbf"` → served from the mounted fonts volume
 *   - `sprite = "{styleJsonFolder}/sprite"` → sibling sprite files next to style.json
 */
function patchStyleForLocal(styleJson: Record<string, unknown>): Record<string, unknown> {
  const patched = { ...styleJson };
  const sources = (patched.sources as Record<string, Record<string, unknown>>) ?? {};
  const newSources: Record<string, Record<string, unknown>> = {};
  for (const [name, src] of Object.entries(sources)) {
    if (src.type === "vector") {
      newSources[name] = { type: "vector", url: "mbtiles://{openmapx}" };
    } else {
      newSources[name] = src;
    }
  }
  patched.sources = newSources;
  patched.glyphs = "{fontstack}/{range}.pbf";
  patched.sprite = "{styleJsonFolder}/sprite";
  return patched;
}

async function downloadOneStyle(
  entry: StyleEntry,
  targetDir: string,
): Promise<{ styleJson: string; spriteFiles: string[] }> {
  mkdirSync(targetDir, { recursive: true });

  // style.json from raw.githubusercontent.com
  const styleUrl = `https://raw.githubusercontent.com/${entry.repo}/${entry.branch}/style.json`;
  const styleJsonPath = join(targetDir, "style.json");
  await curlAtomic(styleUrl, styleJsonPath);

  // Patch in place so tileserver-gl can serve the style from local paths.
  try {
    const raw = JSON.parse(readFileSync(styleJsonPath, "utf-8")) as Record<string, unknown>;
    const patched = patchStyleForLocal(raw);
    writeFileSync(styleJsonPath, `${JSON.stringify(patched, null, 2)}\n`, "utf-8");
  } catch (err) {
    throw new Error(`style ${entry.id}: failed to patch style.json (${(err as Error).message})`);
  }

  // sprite.* from GH Pages. Each suffix is best-effort — @2x variants
  // occasionally 404. The base path defaults to `sprite` (root of the gh-pages
  // deployment), but some styles (e.g. osm-liberty) nest them under
  // `sprites/<name>`; we still save them locally as `sprite.{json,png}` so
  // the patched `sprite: "{styleJsonFolder}/sprite"` reference resolves.
  const [owner, repoName] = entry.repo.split("/");
  const remoteBase = entry.spritePath ?? "sprite";
  const spriteOrigin = `https://${owner}.github.io/${repoName}`;
  const downloaded: string[] = [];
  for (const suffix of SPRITE_SUFFIXES) {
    const url = `${spriteOrigin}/${remoteBase}${suffix}`;
    const target = join(targetDir, `sprite${suffix}`);
    try {
      await curlAtomic(url, target);
      downloaded.push(`sprite${suffix}`);
    } catch {
      // best-effort
    }
  }
  if (!downloaded.includes("sprite.json") || !downloaded.includes("sprite.png")) {
    throw new Error(
      `style ${entry.id}: required sprite files not reachable at ${spriteOrigin}/${remoteBase}.{json,png}`,
    );
  }

  return { styleJson: styleJsonPath, spriteFiles: downloaded };
}

export async function downloadStyle(opts: DownloadStyleOptions): Promise<void> {
  const fontsDir = join(opts.dataDir, "tile-fonts");
  const stylesDir = join(opts.dataDir, "tile-styles");
  mkdirSync(fontsDir, { recursive: true });
  mkdirSync(stylesDir, { recursive: true });

  const urls = resolveStyleAssetUrls();

  // Fonts (shared across every style).
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

  // One subdirectory per style, each with its own style.json + sprite files.
  for (const entry of urls.styles) {
    const styleDir = join(stylesDir, entry.id);
    const result = await downloadOneStyle(entry, styleDir);
    opts.store.upsert({
      type: "tile-styles",
      id: entry.id,
      url: `https://raw.githubusercontent.com/${entry.repo}/${entry.branch}/style.json`,
      sizeBytes: statSync(result.styleJson).size,
      downloadedAt: new Date().toISOString(),
      path: styleDir,
    });
  }
}

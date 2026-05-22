import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const HERE = dirname(fileURLToPath(import.meta.url));
const TINY_GTFS_TEMPLATE_DIR = resolve(HERE, "tiny-gtfs");

/**
 * Region inferred from the feed dirname prefix. The end-to-end test passes
 * `de`/`ch`/`at` to the pipeline's country filter so only these tiny feeds
 * are selected for fetching.
 */
export type TinyGtfsRegion = "de" | "ch" | "at";

export interface TinyGtfsBuildEntry {
  /** e.g. "de_demo" — matches the fixture subdir and the resulting .zip basename. */
  feedName: string;
  /** Two-letter region code used for the Transitous feed filename. */
  region: TinyGtfsRegion;
  /** Absolute path to the materialised `<feedName>.gtfs.zip`. */
  zipPath: string;
}

export interface TinyGtfsBuildResult {
  /** Per-feed map keyed by feedName, value is the absolute zip path. */
  feedZips: Record<string, string>;
  /** Per-feed metadata, sorted alphabetically by feedName for stable test output. */
  entries: TinyGtfsBuildEntry[];
}

/**
 * Materialise the three tiny GTFS feeds checked in under
 * `fixtures/tiny-gtfs/<feedName>/*.txt` into `<outputDir>/<feedName>.gtfs.zip`.
 *
 * Calendar windows are substituted at build time so the feeds always cover
 * `today ± 30 days` — this keeps MOTIS happy regardless of when CI runs.
 *
 * Returns the absolute paths of the resulting zips. The caller is responsible
 * for cleaning `outputDir`.
 */
export async function buildTinyGtfsFeeds(outputDir: string): Promise<TinyGtfsBuildResult> {
  mkdirSync(outputDir, { recursive: true });

  const feedNames = readdirSync(TINY_GTFS_TEMPLATE_DIR).filter((name) =>
    /^[a-z]{2}_[a-z0-9_]+$/.test(name),
  );
  feedNames.sort();

  const entries: TinyGtfsBuildEntry[] = [];
  const feedZips: Record<string, string> = {};

  const { startDate, endDate } = todayWindowYyyymmdd(30);

  for (const feedName of feedNames) {
    const region = feedName.split("_")[0] as TinyGtfsRegion;
    if (region !== "de" && region !== "ch" && region !== "at") {
      throw new Error(`buildTinyGtfsFeeds: unsupported region prefix in ${feedName}`);
    }
    const srcDir = join(TINY_GTFS_TEMPLATE_DIR, feedName);
    const workDir = join(outputDir, `__work_${feedName}`);
    cpSync(srcDir, workDir, { recursive: true });

    // Substitute the today-relative calendar window.
    const calendarPath = join(workDir, "calendar.txt");
    const calendar = readFileSync(calendarPath, "utf-8")
      .replaceAll("__START_DATE__", startDate)
      .replaceAll("__END_DATE__", endDate);
    writeFileSync(calendarPath, calendar);

    const zipPath = join(outputDir, `${feedName}.gtfs.zip`);
    // Use the system `zip` CLI (universally available on macOS + Ubuntu CI
    // runners). `-j` flattens the directory so the .txt files land at the
    // archive root, which is what every GTFS consumer expects.
    await execa("zip", ["-j", "-q", zipPath, ...readdirSyncTxt(workDir)], {
      cwd: workDir,
      stdio: "pipe",
    });

    entries.push({ feedName, region, zipPath });
    feedZips[feedName] = zipPath;
  }

  return { feedZips, entries };
}

function readdirSyncTxt(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .sort();
}

function todayWindowYyyymmdd(deltaDays: number): { startDate: string; endDate: string } {
  const now = new Date();
  const start = new Date(now.getTime() - deltaDays * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  return { startDate: toYyyymmdd(start), endDate: toYyyymmdd(end) };
}

function toYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${dd}`;
}

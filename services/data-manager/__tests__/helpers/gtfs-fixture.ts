import { writeFileSync } from "node:fs";

/**
 * Minimal valid zip archive containing a single `stops.txt` entry. Pipeline
 * fixtures must be readable zips because the validate stage now fails hard on
 * archives `unzip` cannot read; a plain-text placeholder would abort the run.
 * (feed_info.txt is deliberately absent — its absence is a warning, which
 * keeps that branch exercised too.)
 */
const FIXTURE_GTFS_ZIP = Buffer.from(
  "UEsDBBQAAAAAANFk/lx0GS2kIgAAACIAAAAJAAAAc3RvcHMudHh0c3RvcF9pZCxzdG9wX25hbWUKZml4dHVyZSxGaXh0dXJlClBLAQIUAxQAAAAAANFk/lx0GS2kIgAAACIAAAAJAAAAAAAAAAAAAACAAQAAAABzdG9wcy50eHRQSwUGAAAAAAEAAQA3AAAASQAAAAAA",
  "base64",
);

export function writeFixtureGtfsArchive(path: string): void {
  writeFileSync(path, FIXTURE_GTFS_ZIP);
}

export function isFixtureGtfsArchive(bytes: Buffer): boolean {
  return bytes.equals(FIXTURE_GTFS_ZIP);
}

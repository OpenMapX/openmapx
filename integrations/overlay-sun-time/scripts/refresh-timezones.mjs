#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const RELEASE_API =
  "https://api.github.com/repos/evansiroky/timezone-boundary-builder/releases/latest";
// Ocean zones included so a world-zoom overlay has no holes over water, and the
// "now" cut because zones that differ only in pre-1970 history render identically
// today — the smallest complete variant, and the fewest polygons to simplify.
const ASSET_NAME = "timezones-with-oceans-now.geojson.zip";
const MAX_BYTES = 2 * 1024 * 1024;
const SIMPLIFY_PERCENT = "2%";
const COORDINATE_PRECISION = "0.001";

const work = mkdtempSync(join(tmpdir(), "omx-tz-"));

try {
  // Not pinned — a version bump would silently change simplification output —
  // but resolved and recorded below so timezones.meta.json stays an honest
  // record of what actually produced the committed file.
  const mapshaperVersion = execFileSync("npx", ["--yes", "mapshaper", "--version"], {
    encoding: "utf8",
  }).trim();

  const release = await (await fetch(RELEASE_API)).json();
  const asset = release.assets.find((a) => a.name === ASSET_NAME);
  if (!asset) throw new Error(`release has no ${ASSET_NAME} asset`);

  console.log(`Downloading ${release.tag_name} / ${asset.name}`);
  const zipPath = join(work, "timezones.zip");
  const zip = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
  writeFileSync(zipPath, zip);

  execFileSync("unzip", ["-q", "-o", zipPath, "-d", work]);
  const inputName = readdirSync(work).find((f) => f.endsWith(".json"));
  if (!inputName) throw new Error("archive contained no .json file");
  const inputPath = join(work, inputName);

  // mapshaper writes into the temp dir, never straight at the committed file —
  // a validation failure below must leave data/timezones.simplified.json
  // exactly as it was, not overwritten with something bad.
  const stagedOutputPath = join(work, "timezones.simplified.json");
  console.log(`Simplifying ${inputName} to ${SIMPLIFY_PERCENT}`);
  execFileSync("npx", [
    "--yes",
    "mapshaper",
    inputPath,
    "-simplify",
    SIMPLIFY_PERCENT,
    "keep-shapes",
    "-o",
    stagedOutputPath,
    `precision=${COORDINATE_PRECISION}`,
    "format=geojson",
  ]);

  const bytes = readFileSync(stagedOutputPath);
  const parsed = JSON.parse(bytes.toString("utf8"));

  // A bad simplification that silently drops a whole zone must fail here, not
  // ship. Every feature has to survive with a tzid the platform can resolve.
  for (const feature of parsed.features) {
    const tzid = feature.properties?.tzid;
    if (!tzid) throw new Error("a feature lost its tzid during simplification");
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`output is ${bytes.byteLength} bytes, over the ${MAX_BYTES} budget`);
  }

  // Every check above passed — only now does anything land in the tracked data dir.
  const outputPath = join(DATA_DIR, "timezones.simplified.json");
  copyFileSync(stagedOutputPath, outputPath);

  writeFileSync(
    join(DATA_DIR, "timezones.meta.json"),
    `${JSON.stringify(
      {
        release: release.tag_name,
        asset: ASSET_NAME,
        generatedAt: new Date().toISOString(),
        mapshaperVersion,
        featureCount: parsed.features.length,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Wrote ${parsed.features.length} zones, ${bytes.byteLength} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

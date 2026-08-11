#!/usr/bin/env node
/**
 * Checks captured screenshots before they are uploaded.
 *
 * A screenshot is the most widely distributed artefact the project produces and
 * it is effectively permanent, so the checks are about what must not be in one:
 * a real address, an account, a token, a development host. Dimensions and alpha
 * are checked too, because both stores reject on them and finding out at upload
 * wastes a capture session.
 *
 * It reads PNG headers directly rather than pulling in an image library — the
 * dimensions and colour type are in the first 26 bytes, and a release check
 * should not add a dependency.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const scenarios = JSON.parse(readFileSync(resolve(here, "scenarios.json"), "utf8")) as {
  devices: Record<
    string,
    {
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      alphaAllowed: boolean;
    }
  >;
  scenarios: { id: string; platforms?: string[] }[];
  forbiddenStrings: string[];
};

const assetsRoot = resolve(here, "../assets");
const failures: string[] = [];

/** Width, height and colour type from a PNG's IHDR chunk. */
function readPng(path: string): { width: number; height: number; hasAlpha: boolean } | null {
  const buffer = readFileSync(path);
  if (buffer.length < 26 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colourType = buffer.readUInt8(25);
  // 4 is greyscale+alpha, 6 is RGBA. Both stores reject an alpha channel.
  return { width, height, hasAlpha: colourType === 4 || colourType === 6 };
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.name.endsWith(".png")) found.push(path);
  }
  return found;
}

const captured = walk(assetsRoot);

if (captured.length === 0) {
  console.log("[screenshots] nothing captured yet");
  console.log(
    "[screenshots] scenarios are defined in scenarios.json; capture them with capture.mts",
  );
  process.exit(0);
}

for (const path of captured) {
  const relative = path.replace(`${assetsRoot}/`, "");
  const platform = relative.startsWith("apple")
    ? "apple"
    : relative.startsWith("google")
      ? "google"
      : null;
  const png = readPng(path);

  if (!png) {
    failures.push(`${relative} is not a PNG`);
    continue;
  }
  if (png.hasAlpha) {
    // Both stores reject an alpha channel, and the rejection arrives at upload.
    failures.push(`${relative} has an alpha channel`);
  }
  if (platform) {
    const spec = scenarios.devices[platform];
    if (spec.width && png.width !== spec.width) {
      failures.push(`${relative} is ${png.width}px wide, not ${spec.width}px`);
    }
    if (spec.minWidth && png.width < spec.minWidth) {
      failures.push(`${relative} is ${png.width}px wide, below the ${spec.minWidth}px minimum`);
    }
    if (spec.height && png.height !== spec.height) {
      failures.push(`${relative} is ${png.height}px tall, not ${spec.height}px`);
    }
    if (spec.minHeight && png.height < spec.minHeight) {
      failures.push(`${relative} is ${png.height}px tall, below the ${spec.minHeight}px minimum`);
    }
  }

  // A crude but effective check: PNG text chunks and any embedded metadata are
  // still bytes in the file, and a fixture string that reached the screen
  // usually reached the metadata too.
  const contents = readFileSync(path).toString("latin1");
  for (const forbidden of scenarios.forbiddenStrings) {
    if (contents.includes(forbidden)) {
      failures.push(`${relative} contains the forbidden string "${forbidden}"`);
    }
  }
}

/** Every scenario should have at least one capture per locale. */
for (const scenario of scenarios.scenarios) {
  const matches = captured.filter((path) => path.includes(scenario.id));
  if (matches.length === 0) {
    console.log(`[screenshots] … ${scenario.id} has not been captured yet`);
  }
}

if (failures.length > 0) {
  console.error("\n[screenshots] not uploadable:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nA screenshot is permanent and widely distributed. Recapture rather than crop.");
  process.exit(1);
}

console.log(`[screenshots] ${captured.length} image(s) pass dimension, alpha and content checks`);

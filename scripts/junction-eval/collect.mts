import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceFrame } from "./oracle.ts";

const args = process.argv.slice(2);
const value = (key: string, fallback: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(repo, value("--import-audit", `${repo}/plans/junction-review-2026-10-11`));
const destination = resolve(
  repo,
  value("--output", `${repo}/scripts/junction-eval/fixtures/audit-manifest.json`),
);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const cases = JSON.parse(readFileSync(`${source}/data/cases.json`, "utf8")) as {
  id: string;
  region: string;
  lookupSource: string;
  point: { kind: string; side: string; point: number[] };
  image?: { id: string; sequenceId?: string; license: string };
}[];
const outcomes = JSON.parse(readFileSync(`${source}/browser-outcomes.json`, "utf8")).summary as {
  id: string;
  naturalWidth?: number;
  naturalHeight?: number;
}[];
const frames: ReferenceFrame[] = cases.map((c) => {
  const asset = `${source}/browser/assets/${c.image?.id}.jpg`;
  const decoded = outcomes.find((o) => o.id === c.id);
  return {
    id: c.id,
    site: c.point.point.join(","),
    sequence: c.image?.sequenceId ?? `no-photo-${c.id}`,
    region: c.region,
    split: "development",
    source: c.lookupSource.startsWith("PR mapper") ? "pr-raw-osm" : "deployed-mapper",
    collectedAt: "2026-10-11T08:00:00Z",
    revision: "de30954351867fbad2ab6edd33372b211f20fb66",
    evidenceHash: hash(JSON.stringify(c)),
    categories: [c.point.kind, `${c.point.side}-movement`, "synthetic-station-control"],
    ...(c.image && existsSync(asset) && decoded?.naturalWidth && decoded.naturalHeight
      ? {
          photo: {
            id: c.image.id,
            hash: hash(readFileSync(asset)),
            license: c.image.license,
            width: decoded.naturalWidth,
            height: decoded.naturalHeight,
          },
        }
      : {}),
  };
});
mkdirSync(fileURLToPath(new URL("./fixtures", import.meta.url)), { recursive: true });
writeFileSync(destination, `${JSON.stringify(frames, null, 2)}\n`);
console.log(
  JSON.stringify({
    frames: frames.length,
    photos: frames.filter((f) => f.photo).length,
    destination,
  }),
);

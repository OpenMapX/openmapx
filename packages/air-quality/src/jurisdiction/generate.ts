import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Feature, FeatureCollection, Geometry } from "geojson";

import { JURISDICTION_BOUNDARY_ALIASES, JURISDICTION_PROGRAMS } from "./registry";

// shapefile is CommonJS and does not publish declarations. Keeping its narrow
// runtime boundary here also lets consumers compile this generator without
// relying on the package-local ambient declaration being in their TS program.
const shapefile = createRequire(import.meta.url)("shapefile") as {
  read(path: string): Promise<FeatureCollection<Geometry, SourceFeatureProperties>>;
};

export interface SourceFeatureProperties {
  [key: string]: unknown;
}

export interface JurisdictionFeatureProperties {
  kind: "country" | "subdivision" | "ambiguous";
  countryCode: string | null;
  subdivisionCode: string | null;
  name: string;
  sourceId: string;
}

export interface ArtifactInputs {
  admin0: Feature<Geometry, SourceFeatureProperties>[];
  admin1: Feature<Geometry, SourceFeatureProperties>[];
  disputed: Feature<Geometry, SourceFeatureProperties>[];
}

const supportedCountries = new Set(JURISDICTION_PROGRAMS.map(({ countryCode }) => countryCode));

function text(value: unknown): string {
  // The Natural Earth DBF records are fixed-width and some readers preserve the
  // NUL padding. Normalise it at the ingestion boundary so identifiers are not
  // silently rejected (for example, `US\0\0` is not a valid ISO alpha-2 code).
  return String(value ?? "")
    .replaceAll("\0", "")
    .trim();
}

function countryCode(properties: SourceFeatureProperties): string | null {
  for (const value of [
    properties.ISO_A2_EH,
    properties.iso_a2_eh,
    properties.ISO_A2,
    properties.iso_a2,
  ]) {
    const iso = text(value).toUpperCase();
    if (/^[A-Z]{2}$/.test(iso)) return JURISDICTION_BOUNDARY_ALIASES[iso] ?? iso;
  }
  const admin = text(properties.ADM0_A3 ?? properties.adm0_a3).toUpperCase();
  if (admin === "KOS") return "XK";
  return null;
}

function sourceId(properties: SourceFeatureProperties): string {
  return (
    text(
      properties.ADM1_CODE ??
        properties.adm1_code ??
        properties.ADM0_A3 ??
        properties.adm0_a3 ??
        properties.NE_ID ??
        properties.ne_id,
    ) || "unknown"
  );
}

function name(properties: SourceFeatureProperties): string {
  return (
    text(properties.NAME_EN ?? properties.name_en ?? properties.NAME ?? properties.name) ||
    sourceId(properties)
  );
}

function adminA3Codes(properties: SourceFeatureProperties): string[] {
  return Object.entries(properties)
    .filter(([key]) => /^(SOV_A3|ADM0_A3|GU_A3|SU_A3|BRK_A3)(?:_|$)/i.test(key))
    .map(([, value]) => text(value).toUpperCase())
    .filter((value) => /^[A-Z]{3}$/.test(value));
}

function geometryBbox(geometry: Geometry): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    if (Array.isArray(value)) for (const child of value) visit(child);
  };
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) {
      const [childWest, childSouth, childEast, childNorth] = geometryBbox(child);
      west = Math.min(west, childWest);
      south = Math.min(south, childSouth);
      east = Math.max(east, childEast);
      north = Math.max(north, childNorth);
    }
  } else visit(geometry.coordinates);
  if (![west, south, east, north].every(Number.isFinite))
    throw new TypeError("Source feature has empty geometry");
  return [west, south, east, north];
}

function artifactFeature(
  feature: Feature<Geometry, SourceFeatureProperties>,
  properties: JurisdictionFeatureProperties,
): Feature<Geometry, JurisdictionFeatureProperties> {
  return {
    type: "Feature",
    bbox: geometryBbox(feature.geometry),
    geometry: feature.geometry,
    properties,
  };
}

export function buildJurisdictionArtifact(
  inputs: ArtifactInputs,
): FeatureCollection<Geometry, JurisdictionFeatureProperties> {
  const features: Feature<Geometry, JurisdictionFeatureProperties>[] = [];
  const supportedA3Codes = new Set<string>(["KOS"]);
  for (const feature of inputs.admin0) {
    const code = countryCode(feature.properties);
    if (!code || !supportedCountries.has(code)) continue;
    for (const a3 of adminA3Codes(feature.properties)) supportedA3Codes.add(a3);
    features.push(
      artifactFeature(feature, {
        kind: "country",
        countryCode: code,
        subdivisionCode: null,
        name: name(feature.properties),
        sourceId: sourceId(feature.properties),
      }),
    );
  }
  for (const feature of inputs.admin1) {
    const code = countryCode(feature.properties);
    if (code !== "CA") continue;
    const subdivision = text(
      feature.properties.iso_3166_2 ?? feature.properties.ISO_3166_2,
    ).toUpperCase();
    if (!/^CA-[A-Z]{2}$/.test(subdivision)) continue;
    features.push(
      artifactFeature(feature, {
        kind: "subdivision",
        countryCode: "CA",
        subdivisionCode: subdivision,
        name: name(feature.properties),
        sourceId: sourceId(feature.properties),
      }),
    );
  }
  for (const feature of inputs.disputed) {
    if (!adminA3Codes(feature.properties).some((code) => supportedA3Codes.has(code))) continue;
    features.push(
      artifactFeature(feature, {
        kind: "ambiguous",
        countryCode: null,
        subdivisionCode: null,
        name: name(feature.properties),
        sourceId: sourceId(feature.properties),
      }),
    );
  }
  features.sort(
    (left, right) =>
      left.properties.kind.localeCompare(right.properties.kind) ||
      (left.properties.countryCode ?? "").localeCompare(right.properties.countryCode ?? "") ||
      (left.properties.subdivisionCode ?? "").localeCompare(
        right.properties.subdivisionCode ?? "",
      ) ||
      left.properties.sourceId.localeCompare(right.properties.sourceId),
  );
  return { type: "FeatureCollection", features };
}

async function readShapefile(path: string): Promise<Feature<Geometry, SourceFeatureProperties>[]> {
  const result = await shapefile.read(path);
  return (result.features ?? []) as Feature<Geometry, SourceFeatureProperties>[];
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value)
    throw new TypeError(`Missing required ${name} path; the generator never downloads latest data`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function main(): Promise<void> {
  const admin0Path = argument("--admin0");
  const admin1Path = argument("--admin1");
  const disputedPath = argument("--disputed");
  const admin0Archive = argument("--admin0-archive");
  const admin1Archive = argument("--admin1-archive");
  const disputedArchive = argument("--disputed-archive");
  const outputPath = argument("--output");
  const metadataPath = argument("--metadata");
  for (const path of [admin0Path, admin1Path, disputedPath]) {
    const version = (await readFile(path.replace(/\.shp$/, ".VERSION.txt"), "utf8")).trim();
    if (version !== "5.1.1")
      throw new Error(`Expected pinned Natural Earth 5.1.1 input, received ${version}`);
  }
  const artifact = buildJurisdictionArtifact({
    admin0: await readShapefile(admin0Path),
    admin1: await readShapefile(admin1Path),
    disputed: await readShapefile(disputedPath),
  });
  if (artifact.features.length < 6)
    throw new Error("Generated jurisdiction artifact is unexpectedly small");
  const stage = await mkdtemp(join(tmpdir(), "openmapx-aq-jurisdiction-"));
  try {
    const stagedArtifact = join(stage, basename(outputPath));
    const stagedMetadata = join(stage, basename(metadataPath));
    const serialized = `${JSON.stringify(artifact)}\n`;
    const metadata = {
      resolverId: "natural-earth-air-quality",
      resolverRevision: "natural-earth-5.1.1-openmapx-2026-08-30",
      naturalEarthVersion: "5.1.1",
      scale: "1:10m",
      license: "Public domain",
      pointOfView: "default de-facto; disputed-area polygons resolve ambiguous",
      inputs: [
        {
          role: "admin-0",
          path: basename(admin0Archive),
          sha256: await sha256(admin0Archive),
          shapefile: basename(admin0Path),
        },
        {
          role: "admin-1",
          path: basename(admin1Archive),
          sha256: await sha256(admin1Archive),
          shapefile: basename(admin1Path),
        },
        {
          role: "disputed",
          path: basename(disputedArchive),
          sha256: await sha256(disputedArchive),
          shapefile: basename(disputedPath),
        },
      ],
      featureCounts: Object.fromEntries(
        ["country", "subdivision", "ambiguous"].map((kind) => [
          kind,
          artifact.features.filter((feature) => feature.properties.kind === kind).length,
        ]),
      ),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      command:
        "pnpm -C packages/air-quality generate:jurisdiction -- --admin0 <pinned-5.1.1.shp> --admin0-archive <pinned-5.1.1.zip> --admin1 <pinned-5.1.1.shp> --admin1-archive <pinned-5.1.1.zip> --disputed <pinned-5.1.1.shp> --disputed-archive <pinned-5.1.1.zip> --output src/data/jurisdiction/supported.geojson --metadata src/data/jurisdiction/metadata.json",
      eeaCoverageReviewDate: "2026-08-29",
    };
    await writeFile(stagedArtifact, serialized);
    await writeFile(stagedMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
    JSON.parse(await readFile(stagedArtifact, "utf8"));
    JSON.parse(await readFile(stagedMetadata, "utf8"));
    await rename(stagedArtifact, outputPath);
    await rename(stagedMetadata, metadataPath);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) void main();

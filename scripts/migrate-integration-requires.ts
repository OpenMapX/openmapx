#!/usr/bin/env -S node --experimental-strip-types
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const INTEGRATIONS_DIR = join(ROOT, "integrations");

// Mapping from legacy infrastructure.services values to new requires entries.
// Where the integration can fall back to a public endpoint, optional: true.
const SERVICE_TO_REQUIRE: Record<
  string,
  { service?: string; capability?: string; optional?: boolean }
> = {
  postgres: { service: "postgis", optional: false },
  postgis: { service: "postgis", optional: false },
  redis: { service: "redis", optional: false },
  valhalla: { service: "valhalla", optional: true },
  osrm: { service: "osrm", optional: true },
  motis: { service: "motis", optional: true },
  otp: { service: "otp", optional: true },
  nominatim: { service: "nominatim", optional: true },
  photon: { service: "photon", optional: true },
  "pelias-api": { service: "pelias", optional: true },
  pelias: { service: "pelias", optional: true },
  "pelias-placeholder": null as never,
  "pelias-pip": null as never,
  elasticsearch: null as never,
  overpass: { service: "overpass", optional: true },
  martin: { service: "martin", optional: true },
  tileserver: { service: "tileserver", optional: true },
};

// Services that are sub-dependencies of a primary service and don't need their
// own requires: entry (they're covered by the primary service entry).
const SKIP_SERVICES = new Set(["pelias-placeholder", "pelias-pip", "elasticsearch"]);

interface ManifestShape {
  id: string;
  infrastructure?: {
    dockerProfile?: string;
    services?: string[];
    dataRequirements?: string[];
    planetScale?: boolean;
  };
  requires?: Array<{ service?: string; capability?: string; optional?: boolean }>;
}

function migrate(manifestPath: string): boolean {
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as ManifestShape;

  const legacy = manifest.infrastructure;
  if (!legacy || (!legacy.services?.length && !legacy.dockerProfile)) {
    // Nothing to migrate for infrastructure fields, but still clean up if dockerProfile-only
    if (legacy?.dockerProfile) {
      const newManifest: ManifestShape = { ...manifest };
      if (legacy.dataRequirements?.length || legacy.planetScale !== undefined) {
        newManifest.infrastructure = {};
        if (legacy.dataRequirements?.length)
          newManifest.infrastructure.dataRequirements = legacy.dataRequirements;
        if (legacy.planetScale !== undefined)
          newManifest.infrastructure.planetScale = legacy.planetScale;
      } else {
        delete newManifest.infrastructure;
      }
      writeFileSync(manifestPath, `${JSON.stringify(newManifest, null, 2)}\n`, "utf-8");
      return true;
    }
    return false;
  }

  const newRequires: NonNullable<ManifestShape["requires"]> = manifest.requires ?? [];
  const existing = new Set(newRequires.map((r) => r.service ?? r.capability));

  for (const svc of legacy.services ?? []) {
    if (SKIP_SERVICES.has(svc)) continue;

    const mapped = SERVICE_TO_REQUIRE[svc];
    if (!mapped) {
      console.warn(
        `  [${manifest.id}] No mapping for legacy service "${svc}" — skipping (review manually)`,
      );
      continue;
    }

    // biome-ignore lint/style/noNonNullAssertion: mapped entries always have service or capability set
    const key = mapped.service ?? mapped.capability!;
    if (existing.has(key)) continue;

    newRequires.push(mapped);
    existing.add(key);
  }

  const newManifest: ManifestShape = { ...manifest };
  if (newRequires.length > 0) newManifest.requires = newRequires;

  // Keep dataRequirements and planetScale; drop dockerProfile and services.
  if (legacy.dataRequirements?.length || legacy.planetScale !== undefined) {
    newManifest.infrastructure = {};
    if (legacy.dataRequirements?.length)
      newManifest.infrastructure.dataRequirements = legacy.dataRequirements;
    if (legacy.planetScale !== undefined)
      newManifest.infrastructure.planetScale = legacy.planetScale;
  } else {
    delete newManifest.infrastructure;
  }

  writeFileSync(manifestPath, `${JSON.stringify(newManifest, null, 2)}\n`, "utf-8");
  return true;
}

function main(): void {
  const entries = readdirSync(INTEGRATIONS_DIR, { withFileTypes: true });
  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(INTEGRATIONS_DIR, entry.name, "manifest.json");
    try {
      if (!statSync(manifestPath).isFile()) continue;
    } catch {
      continue;
    }

    const changed = migrate(manifestPath);
    if (changed) {
      console.log(`✓ Migrated ${entry.name}`);
      migrated++;
    } else {
      skipped++;
    }
  }

  console.log(`\nMigrated ${migrated} manifests, skipped ${skipped}.`);
}

main();

/**
 * Toolchain-pin gate: the MOTIS version and the `gtfsclean` build commit are
 * each duplicated across Dockerfiles, service manifests, and package.json deps.
 * `@openmapx/transitous-core` holds the single source of truth
 * (`MOTIS_VERSION`, `GTFSCLEAN_COMMIT`); this script asserts every other
 * occurrence matches, so a bump in one place can't silently drift from the
 * others. Mirrors the other scripts/check-*.ts gates (run in pre-commit).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GTFSCLEAN_COMMIT,
  MOBILITYDATA_GBFS_CATALOG_COMMIT,
  MOTIS_VERSION,
} from "@openmapx/transitous-core";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");
const errors: string[] = [];

// MOTIS version: service.json container.tag (motis + staging).
for (const rel of ["services/motis/service.json", "services/motis-staging/service.json"]) {
  const tag = (JSON.parse(read(rel)) as { container?: { tag?: string } }).container?.tag;
  if (tag !== MOTIS_VERSION) {
    errors.push(`${rel}: container.tag "${tag}" != MOTIS_VERSION "${MOTIS_VERSION}"`);
  }
}

// MOTIS version: transitous-tools Dockerfile ARG (v-prefixed release tag).
if (
  !read("services/motis/tools/transitous/Dockerfile").includes(
    `ARG MOTIS_VERSION=v${MOTIS_VERSION}`,
  )
) {
  errors.push(`services/motis/tools/transitous/Dockerfile: ARG MOTIS_VERSION != v${MOTIS_VERSION}`);
}

// MOTIS version: @motis-project/motis-client deps (caret range).
for (const rel of ["apps/api/package.json", "packages/mobility-core/package.json"]) {
  const deps = (JSON.parse(read(rel)) as { dependencies?: Record<string, string> }).dependencies;
  const v = deps?.["@motis-project/motis-client"];
  if (v !== `^${MOTIS_VERSION}`) {
    errors.push(`${rel}: @motis-project/motis-client "${v}" != "^${MOTIS_VERSION}"`);
  }
}

// gtfsclean commit: both images that build it.
for (const rel of [
  "services/motis/tools/transitous/Dockerfile",
  "services/data-manager/Dockerfile",
]) {
  if (!read(rel).includes(`gtfsclean@${GTFSCLEAN_COMMIT}`)) {
    errors.push(`${rel}: gtfsclean commit != ${GTFSCLEAN_COMMIT}`);
  }
}

const gbfsLock = JSON.parse(read("infra/docker/gbfs-catalog.lock.json")) as {
  commit?: string;
  url?: string;
};
if (gbfsLock.commit !== MOBILITYDATA_GBFS_CATALOG_COMMIT) {
  errors.push(
    `infra/docker/gbfs-catalog.lock.json: commit "${gbfsLock.commit}" != MOBILITYDATA_GBFS_CATALOG_COMMIT "${MOBILITYDATA_GBFS_CATALOG_COMMIT}"`,
  );
}
if (!gbfsLock.url?.includes(`/${MOBILITYDATA_GBFS_CATALOG_COMMIT}/systems.csv`)) {
  errors.push("infra/docker/gbfs-catalog.lock.json: URL is not pinned to the catalog commit");
}

// transport-apis catalog: pin.ts is the single source of truth; the lockfile
// and the manifest health checks must name the same immutable commit.
const registryPinSource = read("integrations/transit-dynamic-registry/pin.ts");
const registryCommit = registryPinSource.match(/TRANSPORT_APIS_COMMIT\s*=\s*"([0-9a-f]{40})"/)?.[1];
const registryRef = registryPinSource.match(/TRANSPORT_APIS_REF\s*=\s*"([^"]+)"/)?.[1];
const registryLockedAt = registryPinSource.match(/TRANSPORT_APIS_LOCKED_AT\s*=\s*"([^"]+)"/)?.[1];
if (!registryCommit) {
  errors.push(
    "integrations/transit-dynamic-registry/pin.ts: TRANSPORT_APIS_COMMIT is not a 40-hex commit SHA",
  );
} else {
  const registryLock = JSON.parse(read("infra/docker/transport-apis.lock.json")) as {
    commit?: string;
    ref?: string;
    lockedAt?: string;
  };
  if (registryLock.commit !== registryCommit) {
    errors.push(
      `infra/docker/transport-apis.lock.json: commit "${registryLock.commit}" != TRANSPORT_APIS_COMMIT "${registryCommit}"`,
    );
  }
  if (registryLock.ref !== registryRef) {
    errors.push(
      `infra/docker/transport-apis.lock.json: ref "${registryLock.ref}" != TRANSPORT_APIS_REF "${registryRef}"`,
    );
  }
  if (registryLock.lockedAt !== registryLockedAt) {
    errors.push(
      `infra/docker/transport-apis.lock.json: lockedAt "${registryLock.lockedAt}" != TRANSPORT_APIS_LOCKED_AT "${registryLockedAt}"`,
    );
  }
  const manifest = read("integrations/transit-dynamic-registry/manifest.json");
  if (!manifest.includes(`transport-apis@${registryCommit}`)) {
    errors.push(
      "integrations/transit-dynamic-registry/manifest.json: JSDelivr health check is not pinned to TRANSPORT_APIS_COMMIT",
    );
  }
  if (!manifest.includes(`git/trees/${registryCommit}?recursive=1`)) {
    errors.push(
      "integrations/transit-dynamic-registry/manifest.json: GitHub health check is not pinned to TRANSPORT_APIS_COMMIT",
    );
  }
}

if (errors.length > 0) {
  console.error(
    `✗ Toolchain pins out of sync with @openmapx/transitous-core:\n${errors.map((e) => `  - ${e}`).join("\n")}\n` +
      "Update the literals to match, or bump MOTIS_VERSION / GTFSCLEAN_COMMIT in packages/transitous-core/src/constants.ts.",
  );
  process.exit(1);
}
console.log(
  `✓ Toolchain pins consistent — MOTIS ${MOTIS_VERSION}, gtfsclean ${GTFSCLEAN_COMMIT.slice(0, 10)}, transport-apis ${registryCommit?.slice(0, 10)}.`,
);

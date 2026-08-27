/**
 * Toolchain-pin gate: the MOTIS version and the `gtfsclean` build commit are
 * each duplicated across Dockerfiles, service manifests, and package.json deps.
 * `@openmapx/transitous-core` holds the single source of truth
 * (`MOTIS_VERSION`, `GTFSCLEAN_COMMIT`); this script asserts every other
 * occurrence matches, so a bump in one place can't silently drift from the
 * others. Mirrors the other scripts/check-*.ts gates (run in pre-commit).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

// Third-party production services must retain a readable tag and an immutable
// multi-architecture manifest digest. First-party OpenMapX images are released
// by this repository and intentionally follow the separately gated digest
// promotion workflow.
for (const entry of readdirSync(join(ROOT, "services"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const rel = `services/${entry.name}/service.json`;
  if (!existsSync(join(ROOT, rel))) continue;
  const manifest = JSON.parse(read(rel)) as {
    container?: { image?: string; digest?: string };
  };
  const container = manifest.container;
  if (!container?.image || container.image.startsWith("ghcr.io/openmapx/")) continue;
  if (!OCI_DIGEST.test(container.digest ?? "")) {
    errors.push(`${rel}: third-party image is missing a valid immutable sha256 digest`);
  }
}

// MOTIS version: service.json container.tag (motis + staging).
for (const rel of ["services/motis/service.json", "services/motis-staging/service.json"]) {
  const container = (JSON.parse(read(rel)) as { container?: { tag?: string; digest?: string } })
    .container;
  const tag = container?.tag;
  if (tag !== MOTIS_VERSION) {
    errors.push(`${rel}: container.tag "${tag}" != MOTIS_VERSION "${MOTIS_VERSION}"`);
  }
  if (!OCI_DIGEST.test(container?.digest ?? "")) {
    errors.push(`${rel}: MOTIS image is not pinned by digest`);
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

// React Native's Jest preset imports runtime-internal entry points, so even a
// semver-minor drift can make every mobile suite fail before tests execute.
const mobilePackage = JSON.parse(read("apps/mobile/package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const reactNativeVersion = mobilePackage.dependencies?.["react-native"];
const reactNativeJestPreset = mobilePackage.devDependencies?.["@react-native/jest-preset"];
if (!reactNativeVersion || reactNativeJestPreset !== reactNativeVersion) {
  errors.push(
    `apps/mobile/package.json: @react-native/jest-preset "${reactNativeJestPreset}" must exactly match react-native "${reactNativeVersion}"`,
  );
}

// gtfsclean commit: every image that builds it.
for (const rel of [
  "services/motis/tools/transitous/Dockerfile",
  "services/data-manager/Dockerfile",
  "apps/transitous-runner/Dockerfile",
]) {
  if (!read(rel).includes(`gtfsclean@${GTFSCLEAN_COMMIT}`)) {
    errors.push(`${rel}: gtfsclean commit != ${GTFSCLEAN_COMMIT}`);
  }
}

const dataManagerDockerfile = read("services/data-manager/Dockerfile");
for (const artifact of ["DOCKER_CLI", "DOCKER_COMPOSE", "DUCKDB"] as const) {
  for (const arch of ["AMD64", "ARM64"] as const) {
    const value = dataManagerDockerfile.match(
      new RegExp(`ARG ${artifact}_SHA256_${arch}=([a-f0-9]{64})`),
    )?.[1];
    if (!value || !SHA256.test(value)) {
      errors.push(`services/data-manager/Dockerfile: ${artifact}_SHA256_${arch} is not pinned`);
    }
  }
}
if ((dataManagerDockerfile.match(/sha256sum -c -/g) ?? []).length < 3) {
  errors.push("services/data-manager/Dockerfile: every downloaded executable must be checksummed");
}

const transitousDockerfile = read("services/motis/tools/transitous/Dockerfile");
for (const arch of ["AMD64", "ARM64"] as const) {
  const value = transitousDockerfile.match(
    new RegExp(`ARG MOTIS_SHA256_${arch}=([a-f0-9]{64})`),
  )?.[1];
  if (!value || !SHA256.test(value)) {
    errors.push(`services/motis/tools/transitous/Dockerfile: MOTIS_SHA256_${arch} is not pinned`);
  }
}
if (!transitousDockerfile.includes("sha256sum -c -")) {
  errors.push("services/motis/tools/transitous/Dockerfile: MOTIS download is not checksummed");
}

const requirementsInput = read("services/motis/tools/transitous/requirements.in");
const requirementsLock = read("services/motis/tools/transitous/requirements.txt");
for (const requirement of requirementsInput
  .split("\n")
  .filter((line) => line && !line.startsWith("#"))) {
  const packageName = requirement.split("==", 1)[0]?.toLowerCase().replaceAll(/[._]/g, "-");
  if (packageName && !requirementsLock.toLowerCase().includes(`${packageName}==`)) {
    errors.push(
      `services/motis/tools/transitous/requirements.txt: missing direct pin ${requirement}`,
    );
  }
}
const lockedRequirementBlocks = requirementsLock
  .split(/\n(?=[a-z0-9][a-z0-9._-]*==)/i)
  .filter((block) => /^[a-z0-9][a-z0-9._-]*==/i.test(block));
if (
  lockedRequirementBlocks.length === 0 ||
  lockedRequirementBlocks.some((block) => !block.includes("--hash=sha256:"))
) {
  errors.push(
    "services/motis/tools/transitous/requirements.txt: every locked package needs a hash",
  );
}
for (const [rel, dockerfile] of [
  ["services/data-manager/Dockerfile", dataManagerDockerfile],
  ["services/motis/tools/transitous/Dockerfile", transitousDockerfile],
  ["apps/transitous-runner/Dockerfile", read("apps/transitous-runner/Dockerfile")],
] as const) {
  if (!dockerfile.includes("pip3 install --no-cache-dir --require-hashes")) {
    errors.push(`${rel}: Python lock installation must use --require-hashes`);
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
    `✗ Production supply-chain pins are incomplete or out of sync:\n${errors.map((e) => `  - ${e}`).join("\n")}\n` +
      "Update the reviewed image/artifact/Python pins together with their source versions.",
  );
  process.exit(1);
}
console.log(
  `✓ Supply-chain pins consistent — immutable third-party images, checked release artifacts, hash-locked Python, MOTIS ${MOTIS_VERSION}, gtfsclean ${GTFSCLEAN_COMMIT.slice(0, 10)}, transport-apis ${registryCommit?.slice(0, 10)}.`,
);

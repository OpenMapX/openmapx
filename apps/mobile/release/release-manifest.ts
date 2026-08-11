import { createHash } from "node:crypto";

/**
 * What was built, from what, on what.
 *
 * The promise this makes is deliberately narrow. A signed archive is not
 * bit-identical between two runs — timestamps, signature nonces and the
 * signing certificate all differ — so claiming reproducibility would be false.
 * What the manifest does promise is that the *inputs* are recorded: the commit,
 * the dependency locks, the normalized generated native surface, the toolchains,
 * the permission and privacy surfaces, and a hash of each artifact.
 *
 * That is enough to answer the question that actually gets asked six months
 * later, when a report arrives against build 47: what was in it, and can we
 * build something equivalent again?
 *
 * Nothing secret is recorded. No keystore path, no password, no API key, no
 * certificate private material — only public fingerprints, which the app itself
 * publishes.
 */

export interface ArtifactRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  generatedAtMs: number;
  git: { commit: string; tag: string | null; dirty: boolean };
  version: {
    marketingVersion: string;
    iosBuildNumber: string;
    androidVersionCode: number;
    protocol: { min: number; max: number };
    channel: string;
  };
  identity: { appId: string; scheme: string; origin: string };
  toolchains: Record<string, string>;
  locks: ArtifactRecord[];
  /** The hash `mobile:prebuild:check` computes for the normalized native tree. */
  generatedNativeHash: string | null;
  surfaces: { permissionsSha256: string; dataPracticesSha256: string };
  publicSigning: { appleTeamId: string | null; playAppSigningSha256: string | null };
  artifacts: ArtifactRecord[];
}

export function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface BuildManifestInput {
  nowMs: number;
  git: { commit: string; tag: string | null; dirty: boolean };
  version: ReleaseManifest["version"];
  identity: ReleaseManifest["identity"];
  toolchains: Record<string, string>;
  locks: ArtifactRecord[];
  generatedNativeHash: string | null;
  permissionsSource: string;
  dataPracticesSource: string;
  publicSigning: ReleaseManifest["publicSigning"];
  artifacts: ArtifactRecord[];
}

export function buildReleaseManifest(input: BuildManifestInput): ReleaseManifest {
  return {
    schemaVersion: 1,
    generatedAtMs: input.nowMs,
    git: input.git,
    version: input.version,
    identity: input.identity,
    toolchains: input.toolchains,
    locks: input.locks,
    generatedNativeHash: input.generatedNativeHash,
    surfaces: {
      permissionsSha256: sha256(input.permissionsSource),
      dataPracticesSha256: sha256(input.dataPracticesSource),
    },
    publicSigning: input.publicSigning,
    artifacts: input.artifacts,
  };
}

/** Patterns that would mean something secret reached the manifest. */
const SECRET_MARKERS = [
  "BEGIN PRIVATE KEY",
  "BEGIN RSA PRIVATE KEY",
  "BEGIN EC PRIVATE KEY",
  "BEGIN OPENSSH PRIVATE KEY",
  ".p12",
  ".jks",
  ".keystore",
  ".mobileprovision",
  "storePassword",
  "keyPassword",
  "ASC_API_KEY",
  "app-specific-password",
];

/**
 * Refuses to publish a manifest that carries something it should not.
 *
 * Runs on the serialized form rather than the object, because the mistake this
 * catches is a path or a password arriving inside a field nobody thought to
 * check — a toolchain string, an artifact path, a git tag.
 */
export function findSecretsInManifest(manifest: ReleaseManifest): string[] {
  const serialized = JSON.stringify(manifest);
  return SECRET_MARKERS.filter((marker) => serialized.toLowerCase().includes(marker.toLowerCase()));
}

/**
 * Whether two manifests describe equivalent builds.
 *
 * Compares inputs, not artifact hashes: two signed archives from identical
 * inputs differ, and expecting otherwise would make this permanently red.
 */
export function inputsMatch(a: ReleaseManifest, b: ReleaseManifest): boolean {
  return (
    a.git.commit === b.git.commit &&
    a.generatedNativeHash === b.generatedNativeHash &&
    a.surfaces.permissionsSha256 === b.surfaces.permissionsSha256 &&
    a.surfaces.dataPracticesSha256 === b.surfaces.dataPracticesSha256 &&
    JSON.stringify(a.locks) === JSON.stringify(b.locks) &&
    JSON.stringify(a.version) === JSON.stringify(b.version)
  );
}

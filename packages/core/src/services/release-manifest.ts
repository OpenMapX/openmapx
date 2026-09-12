/**
 * The aggregate OpenMapX release manifest published by
 * `.github/workflows/docker.yml` as `<registry>/<namespace>/release-manifest:latest`.
 * Parsing and overlay rendering are shared by the admin system updater
 * (apps/api) and the CLI so both produce byte-identical
 * `docker-compose.release.yml` overlays.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import z from "zod/v4";

export const DEFAULT_RELEASE_MANIFEST_IMAGE = "ghcr.io/openmapx/release-manifest:latest";
export const RELEASE_MANIFEST_IMAGE_ENV = "OPENMAPX_RELEASE_MANIFEST_IMAGE";
export const RELEASE_MANIFEST_CONTAINER_PATH = "/release-manifest.json";
/** Runtime services whose images the release overlay pins as one release. */
export const RELEASE_PINNED_SERVICE_IDS = [
  "app-api",
  "app-web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
] as const;
export const TRANSITOUS_TOOLS_IMAGE_ENV = "OPENMAPX_TRANSITOUS_TOOLS_IMAGE";
export const PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV = "OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE";
export const PRIVACY_RELEASE_VALIDATION_EVIDENCE_ENV = "PRIVACY_EXPORT_VALIDATION_EVIDENCE_FILE";
export const PRIVACY_RELEASE_VALIDATION_EVIDENCE_PATH =
  "/run/openmapx/privacy-release-validation.json";
const PRIVACY_RELEASE_EVIDENCE_DIRECTORY = ".release-evidence";

export const RELEASE_IMAGE_NAMES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "privacy-backup",
  "transitous-runner",
  "transitous-tools",
] as const;
const DIGEST = "sha256:[a-f0-9]{64}";

export type ReleaseChannel =
  | { kind: "disabled" }
  | { kind: "enabled"; manifestImage: string; imagePrefix: string };

function envValue(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function imagePrefixOf(image: string): string {
  const slash = image.lastIndexOf("/");
  if (slash <= 0) {
    throw new Error(
      `${RELEASE_MANIFEST_IMAGE_ENV} must look like <registry>/<namespace>/release-manifest[:tag]`,
    );
  }
  return image.slice(0, slash);
}

/**
 * Resolve the release channel. Forks and mirrored registries point
 * `OPENMAPX_RELEASE_MANIFEST_IMAGE` at their own manifest image; its
 * registry/namespace then becomes the approved prefix for every pinned image
 * (digests are still mandatory). An explicitly empty value disables release
 * resolution for local-image workflows, so callers report "unpinned" once
 * instead of retrying the registry on every start.
 */
export function releaseChannel(
  configured: string | undefined = envValue(RELEASE_MANIFEST_IMAGE_ENV),
): ReleaseChannel {
  if (configured !== undefined && configured.trim() === "") return { kind: "disabled" };
  const manifestImage = configured?.trim() || DEFAULT_RELEASE_MANIFEST_IMAGE;
  return { kind: "enabled", manifestImage, imagePrefix: imagePrefixOf(manifestImage) };
}

export class ReleaseChannelDisabledError extends Error {
  constructor() {
    super(`Release resolution is disabled (${RELEASE_MANIFEST_IMAGE_ENV} is empty)`);
    this.name = "ReleaseChannelDisabledError";
  }
}

/** The manifest image to pull, or throws {@link ReleaseChannelDisabledError}. */
export function releaseManifestImage(): string {
  const channel = releaseChannel();
  if (channel.kind === "disabled") throw new ReleaseChannelDisabledError();
  return channel.manifestImage;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  release: string;
  images: Record<(typeof RELEASE_IMAGE_NAMES)[number], string> & { docs?: string };
  privacyReleaseValidation: PrivacyReleaseValidationEvidence;
}

export interface PrivacyReleaseValidationEvidence {
  version: 1;
  sourceBuildFingerprint: string;
  validatedAt: string;
  checks: {
    translationsConsistent: true;
    openApiConsistent: true;
    policyConsistent: true;
  };
}

const privacyReleaseValidationSchema = z
  .object({
    version: z.literal(1),
    sourceBuildFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    validatedAt: z.iso.datetime({ offset: true }),
    checks: z
      .object({
        translationsConsistent: z.literal(true),
        openApiConsistent: z.literal(true),
        policyConsistent: z.literal(true),
      })
      .strict(),
  })
  .strict();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function defaultImagePrefix(): string {
  const channel = releaseChannel();
  return channel.kind === "enabled"
    ? channel.imagePrefix
    : imagePrefixOf(DEFAULT_RELEASE_MANIFEST_IMAGE);
}

export function parseReleaseManifest(
  raw: string,
  imagePrefix: string = defaultImagePrefix(),
): ReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Release lockfile is not valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object") throw new Error("Release lockfile must be an object");
  const candidate = value as {
    schemaVersion?: unknown;
    release?: unknown;
    images?: unknown;
    privacyReleaseValidation?: unknown;
  };
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported release lockfile schemaVersion");
  if (typeof candidate.release !== "string" || !candidate.release.trim()) {
    throw new Error("Release lockfile release must be a non-empty string");
  }
  if (!candidate.images || typeof candidate.images !== "object") {
    throw new Error("Release lockfile images must be an object");
  }
  const images = candidate.images as Record<string, unknown>;
  for (const name of [...RELEASE_IMAGE_NAMES, ...(Object.hasOwn(images, "docs") ? ["docs"] : [])]) {
    const pattern = new RegExp(`^${escapeRegExp(imagePrefix)}/${escapeRegExp(name)}@${DIGEST}$`);
    const image = images[name];
    if (typeof image !== "string" || !pattern.test(image)) {
      throw new Error(
        `Release lockfile images.${name} is not an approved immutable reference under ${imagePrefix}`,
      );
    }
  }
  const validation = privacyReleaseValidationSchema.safeParse(candidate.privacyReleaseValidation);
  if (!validation.success) {
    const field = validation.error.issues[0]?.path.join(".");
    throw new Error(
      `Release lockfile privacyReleaseValidation${field ? `.${field}` : ""} is invalid`,
    );
  }
  return candidate as ReleaseManifest;
}

/** Stable bytes used by the ops-agent release store and transaction digest. */
export function canonicalReleaseManifest(manifest: ReleaseManifest): string {
  return JSON.stringify({
    schemaVersion: 1,
    release: manifest.release,
    images: {
      api: manifest.images.api,
      web: manifest.images.web,
      "data-manager": manifest.images["data-manager"],
      "ops-agent": manifest.images["ops-agent"],
      "privacy-backup": manifest.images["privacy-backup"],
      "transitous-runner": manifest.images["transitous-runner"],
      "transitous-tools": manifest.images["transitous-tools"],
      docs: manifest.images.docs,
    },
    privacyReleaseValidation: {
      version: manifest.privacyReleaseValidation.version,
      sourceBuildFingerprint: manifest.privacyReleaseValidation.sourceBuildFingerprint,
      validatedAt: manifest.privacyReleaseValidation.validatedAt,
      checks: {
        translationsConsistent: manifest.privacyReleaseValidation.checks.translationsConsistent,
        openApiConsistent: manifest.privacyReleaseValidation.checks.openApiConsistent,
        policyConsistent: manifest.privacyReleaseValidation.checks.policyConsistent,
      },
    },
  });
}

function privacyReleaseValidationEvidenceContents(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest.privacyReleaseValidation)}\n`;
}

function privacyReleaseValidationEvidenceFilename(manifest: ReleaseManifest): string {
  const digest = createHash("sha256")
    .update(privacyReleaseValidationEvidenceContents(manifest))
    .digest("hex");
  return `privacy-release-validation-${digest}.json`;
}

export function renderReleaseCompose(manifest: ReleaseManifest): string {
  const validationEvidenceFile = privacyReleaseValidationEvidenceFilename(manifest);
  return [
    `x-openmapx-release: ${JSON.stringify({ release: manifest.release, images: Object.fromEntries(RELEASE_IMAGE_NAMES.map((name) => [name, manifest.images[name]])) })}`,
    "services:",
    "  app-api:",
    `    image: ${manifest.images.api}`,
    "    environment:",
    `      ${PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV}: ${manifest.images["privacy-backup"]}`,
    `      ${PRIVACY_RELEASE_VALIDATION_EVIDENCE_ENV}: \${${PRIVACY_RELEASE_VALIDATION_EVIDENCE_ENV}:-${PRIVACY_RELEASE_VALIDATION_EVIDENCE_PATH}}`,
    "    configs:",
    "      - source: privacy-release-validation",
    `        target: ${PRIVACY_RELEASE_VALIDATION_EVIDENCE_PATH}`,
    "  app-web:",
    `    image: ${manifest.images.web}`,
    "  data-manager:",
    `    image: ${manifest.images["data-manager"]}`,
    "    environment:",
    `      ${TRANSITOUS_TOOLS_IMAGE_ENV}: ${manifest.images["transitous-tools"]}`,
    "  ops-agent:",
    `    image: ${manifest.images["ops-agent"]}`,
    "    environment:",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Docker Compose default expression
    "      OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED: ${OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED:-true}",
    `      ${PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV}: ${manifest.images["privacy-backup"]}`,
    "  transitous-runner:",
    `    image: ${manifest.images["transitous-runner"]}`,
    "configs:",
    "  privacy-release-validation:",
    `    file: ./${PRIVACY_RELEASE_EVIDENCE_DIRECTORY}/${validationEvidenceFile}`,
    "",
  ].join("\n");
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    throw new Error("Release evidence directory is unsafe");
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readImmutableEvidence(path: string): string {
  const before = lstatSync(path);
  const currentUid = process.getuid?.();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o444 ||
    (currentUid !== undefined && before.uid !== currentUid)
  ) {
    throw new Error("Release validation evidence is unsafe");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Release validation evidence is unsafe");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Publish immutable evidence first, then atomically switch the Compose overlay. */
export function writeReleaseComposeArtifacts(
  manifest: ReleaseManifest,
  overlayPath: string,
): { evidencePath: string; overlayPath: string } {
  const evidenceDirectory = join(dirname(overlayPath), PRIVACY_RELEASE_EVIDENCE_DIRECTORY);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(evidenceDirectory);
  fsyncDirectory(dirname(overlayPath));
  const evidencePath = join(evidenceDirectory, privacyReleaseValidationEvidenceFilename(manifest));
  const evidence = privacyReleaseValidationEvidenceContents(manifest);
  if (existsSync(evidencePath)) {
    if (readImmutableEvidence(evidencePath) !== evidence) {
      throw new Error("Release validation evidence is unsafe");
    }
  } else {
    const temporaryEvidence = join(
      evidenceDirectory,
      `.${privacyReleaseValidationEvidenceFilename(manifest)}.${randomBytes(12).toString("hex")}.partial`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryEvidence,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o444,
      );
      writeFileSync(descriptor, evidence, { encoding: "utf8" });
      fchmodSync(descriptor, 0o444);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryEvidence, evidencePath);
      fsyncDirectory(evidenceDirectory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryEvidence, { force: true });
    }
  }
  const temporaryOverlay = `${overlayPath}.${randomBytes(12).toString("hex")}.partial`;
  let overlayDescriptor: number | undefined;
  try {
    overlayDescriptor = openSync(
      temporaryOverlay,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(overlayDescriptor, renderReleaseCompose(manifest), { encoding: "utf8" });
    fsyncSync(overlayDescriptor);
    closeSync(overlayDescriptor);
    overlayDescriptor = undefined;
    renameSync(temporaryOverlay, overlayPath);
    fsyncDirectory(dirname(overlayPath));
  } finally {
    if (overlayDescriptor !== undefined) closeSync(overlayDescriptor);
    rmSync(temporaryOverlay, { force: true });
  }
  return { evidencePath, overlayPath };
}

/**
 * Read the Transitous helper image pinned by an existing release overlay. The
 * overlay is our own rendered output, so a targeted line match is sufficient
 * and avoids a YAML dependency in callers.
 */
export function transitousToolsImageFromReleaseCompose(overlayYaml: string): string | null {
  const match = new RegExp(`^\\s*${TRANSITOUS_TOOLS_IMAGE_ENV}:\\s*(\\S+)\\s*$`, "m").exec(
    overlayYaml,
  );
  const image = match?.[1];
  return image && new RegExp(`^[a-z0-9][a-z0-9._/-]*/transitous-tools@${DIGEST}$`).test(image)
    ? image
    : null;
}

export interface ReleaseComposeSelection {
  release: string | null;
  images: Partial<Record<(typeof RELEASE_IMAGE_NAMES)[number], string>>;
}

/** Read local selection, never infer running container versions from the overlay. */
export function parseReleaseComposeSelection(raw: string): ReleaseComposeSelection {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const document = object(load(raw, { schema: JSON_SCHEMA }));
  if (
    !document.services ||
    typeof document.services !== "object" ||
    Array.isArray(document.services)
  ) {
    throw new Error("Release overlay must contain a services mapping");
  }
  const services = object(document.services);
  const images: ReleaseComposeSelection["images"] = {};
  const pins: Record<string, unknown> = {
    api: object(services["app-api"]).image,
    web: object(services["app-web"]).image,
    "data-manager": object(services["data-manager"]).image,
    "ops-agent": object(services["ops-agent"]).image,
    "transitous-runner": object(services["transitous-runner"]).image,
    "privacy-backup": object(object(services["ops-agent"]).environment)[
      PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV
    ],
    "transitous-tools": object(object(services["data-manager"]).environment)[
      TRANSITOUS_TOOLS_IMAGE_ENV
    ],
  };
  // Both consumers must agree; otherwise no single helper pin describes this overlay.
  const apiCollector = object(object(services["app-api"]).environment)[
    PRIVACY_BACKUP_COLLECTOR_IMAGE_ENV
  ];
  if (apiCollector !== pins["privacy-backup"]) delete pins["privacy-backup"];
  for (const name of RELEASE_IMAGE_NAMES) {
    const pin = pins[name];
    if (typeof pin === "string" && new RegExp(`^\\S+@${DIGEST}$`).test(pin)) images[name] = pin;
  }
  const metadata = object(document["x-openmapx-release"]);
  const metadataImages = object(metadata.images);
  const matches = RELEASE_IMAGE_NAMES.every(
    (name) => images[name] && metadataImages[name] === images[name],
  );
  return {
    release:
      matches && typeof metadata.release === "string" && metadata.release.trim()
        ? metadata.release
        : null,
    images,
  };
}

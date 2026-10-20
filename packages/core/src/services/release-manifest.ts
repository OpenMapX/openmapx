/**
 * The aggregate OpenMapX release manifest published by
 * `.github/workflows/docker.yml` as `<registry>/<namespace>/release-manifest:main`.
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

/** The seven application images; documentation publishes independently. */
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

export const RELEASE_SELECTOR_ENV = "OPENMAPX_RELEASE";
export const RELEASE_REPOSITORY_ENV = "OPENMAPX_RELEASE_MANIFEST_REPOSITORY";
export const DEFAULT_RELEASE_MANIFEST_REPOSITORY = "ghcr.io/openmapx/release-manifest";
export const PRODUCT_VERSION_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|beta|rc)\.(0|[1-9]\d*)$/;
export type ReleaseSelection =
  | { kind: "local" }
  | {
      kind: "main" | "preview" | "version" | "digest";
      selector: string;
      manifestImage: string;
      manifestRepository: string;
      imagePrefix: string;
      expectedVersion?: string;
    };
export type ReleaseChannel =
  | { kind: "disabled" }
  | {
      kind: "enabled";
      manifestImage: string;
      imagePrefix: string;
      selection: Exclude<ReleaseSelection, { kind: "local" }>;
    };
function envValue(name: string): string | undefined {
  return process.env?.[name];
}
function imagePrefixOf(image: string): string {
  return image.slice(0, image.lastIndexOf("/"));
}
export function normalizeReleaseSelection(
  selector: string = "main",
  manifestRepository: string = DEFAULT_RELEASE_MANIFEST_REPOSITORY,
): ReleaseSelection {
  if (
    !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*\/release-manifest$/.test(
      manifestRepository,
    ) ||
    manifestRepository.split("/").some((part) => part === "." || part === ".." || part === "")
  )
    throw new Error(
      `${RELEASE_REPOSITORY_ENV} must be a registry/namespace/release-manifest repository without a tag or digest`,
    );
  if (selector === "local") return { kind: "local" };
  const kind =
    selector === "main" || selector === "preview"
      ? selector
      : PRODUCT_VERSION_PATTERN.test(selector)
        ? "version"
        : /^sha256:[a-f0-9]{64}$/.test(selector)
          ? "digest"
          : undefined;
  if (!kind)
    throw new Error(
      `Unsupported ${RELEASE_SELECTOR_ENV}: ${selector}. Choose main, preview, an exact prerelease version/digest, or local.`,
    );
  return {
    kind,
    selector,
    manifestRepository,
    manifestImage: `${manifestRepository}${kind === "digest" ? "@" : ":"}${selector}`,
    imagePrefix: imagePrefixOf(manifestRepository),
    ...(kind === "version" ? { expectedVersion: selector } : {}),
  };
}
export function releaseSelection(): ReleaseSelection {
  return normalizeReleaseSelection(
    envValue(RELEASE_SELECTOR_ENV),
    envValue(RELEASE_REPOSITORY_ENV),
  );
}
export function releaseChannel(
  ...configuration: [selector?: string, repository?: string]
): ReleaseChannel {
  const selection = configuration.length
    ? normalizeReleaseSelection(...configuration)
    : releaseSelection();
  return selection.kind === "local"
    ? { kind: "disabled" }
    : {
        kind: "enabled",
        manifestImage: selection.manifestImage,
        imagePrefix: selection.imagePrefix,
        selection,
      };
}
export class ReleaseChannelDisabledError extends Error {
  constructor() {
    super(`Release resolution is disabled (${RELEASE_SELECTOR_ENV}=local)`);
    this.name = "ReleaseChannelDisabledError";
  }
}
export function releaseManifestImage(): string {
  const channel = releaseChannel();
  if (channel.kind === "disabled") throw new ReleaseChannelDisabledError();
  return channel.manifestImage;
}
/** Docker pull's digest is an OCI identity, not the local image configuration ID. */
export function releaseDigestFromPull(output: string): string {
  const matches = [...output.matchAll(/^Digest: (sha256:[a-f0-9]{64})\r?$/gm)];
  if (matches.length !== 1)
    throw new Error("Docker pull did not return one unambiguous release manifest digest");
  return matches[0][1];
}
export function validateResolvedSelection(
  selection: ReleaseSelection,
  manifest: ReleaseManifest,
  ociDigest: string,
): void {
  if (selection.kind === "local") throw new ReleaseChannelDisabledError();
  if (selection.kind === "digest" && ociDigest !== selection.selector)
    throw new Error("Resolved manifest digest does not match selection");
  if (
    selection.kind === "version" &&
    (manifest.release !== selection.expectedVersion ||
      `v${manifest.product?.version}` !== selection.expectedVersion)
  )
    throw new Error("Resolved manifest version does not match selection");
  if (selection.kind === "preview" && !manifest.product)
    throw new Error("Preview is not a named product release");
}

export interface ReleaseProducer {
  repository: string;
  workflowPath: ".github/workflows/ci.yml";
  sourceRevision: string;
  runId: number;
  runAttempt: number;
  event: "push" | "schedule";
}
export interface ReleaseBuildMetadata {
  version: 1;
  images: Partial<
    Record<
      (typeof RELEASE_IMAGE_NAMES)[number],
      { sourceRevision: string; inputHash: string; builtAt: string; coldRefreshedAt?: string }
    >
  >;
}
export interface ProductReleaseMetadata {
  version: string;
  sourceRelease: string;
  sourceRevision: string;
  producer: ReleaseProducer;
  notesSha256: string;
  compatibility: { extensionProtocol: string; platforms: string[] };
  upgradeOrigins: string[];
  limitations: string[];
}
export interface ReleaseManifest {
  schemaVersion: 1;
  release: string;
  images: Record<(typeof RELEASE_IMAGE_NAMES)[number], string>;
  privacyReleaseValidation: PrivacyReleaseValidationEvidence;
  producer?: ReleaseProducer;
  buildMetadata?: ReleaseBuildMetadata;
  product?: ProductReleaseMetadata;
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

const producerSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  workflowPath: z.literal(".github/workflows/ci.yml"),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  event: z.enum(["push", "schedule"]),
});
const buildMetadataSchema = z.strictObject({
  version: z.literal(1),
  images: z.partialRecord(
    z.enum(RELEASE_IMAGE_NAMES),
    z.strictObject({
      sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      builtAt: z.iso.datetime({ offset: true }),
      coldRefreshedAt: z.iso.datetime({ offset: true }).optional(),
    }),
  ),
});
const productSchema = z.strictObject({
  version: z.string().refine((value) => PRODUCT_VERSION_PATTERN.test(`v${value}`)),
  sourceRelease: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  producer: producerSchema,
  notesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  compatibility: z.strictObject({
    extensionProtocol: z.string().min(1),
    platforms: z.array(z.literal("linux/amd64")).length(1),
  }),
  upgradeOrigins: z.array(z.string().min(1)).min(1),
  limitations: z.array(z.string().min(1)),
});
function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableObject(item)]),
    );
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function defaultImagePrefix(): string {
  const channel = releaseChannel();
  return channel.kind === "enabled"
    ? channel.imagePrefix
    : imagePrefixOf(envValue(RELEASE_REPOSITORY_ENV) ?? DEFAULT_RELEASE_MANIFEST_REPOSITORY);
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
    producer?: unknown;
    buildMetadata?: unknown;
    product?: unknown;
  };
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported release lockfile schemaVersion");
  if (
    typeof candidate.release !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.release)
  ) {
    throw new Error("Release lockfile release must be a non-empty string");
  }
  if (!candidate.images || typeof candidate.images !== "object") {
    throw new Error("Release lockfile images must be an object");
  }
  const images = candidate.images as Record<string, unknown>;
  for (const name of RELEASE_IMAGE_NAMES) {
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
  for (const [field, schema] of [
    ["producer", producerSchema],
    ["buildMetadata", buildMetadataSchema],
    ["product", productSchema],
  ] as const) {
    if (candidate[field] !== undefined && !schema.safeParse(candidate[field]).success)
      throw new Error(`Release lockfile ${field} is invalid`);
  }
  const product = candidate.product as ProductReleaseMetadata | undefined;
  if (
    product &&
    (candidate.release !== `v${product.version}` ||
      product.sourceRevision !== product.producer.sourceRevision ||
      JSON.stringify(stableObject(candidate.producer)) !==
        JSON.stringify(stableObject(product.producer)))
  )
    throw new Error("Release product identity does not match producer");
  return {
    ...candidate,
    images: Object.fromEntries(RELEASE_IMAGE_NAMES.map((name) => [name, images[name]])),
  } as ReleaseManifest;
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
    ...(manifest.producer ? { producer: stableObject(manifest.producer) } : {}),
    // Legacy producerless manifests were stored without this then-informational
    // field. Preserve their bytes/IDs; producer-bound manifests make it authority.
    ...(manifest.producer && manifest.buildMetadata
      ? { buildMetadata: stableObject(manifest.buildMetadata) }
      : {}),
    ...(manifest.product ? { product: stableObject(manifest.product) } : {}),
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
    `x-openmapx-release: ${JSON.stringify({ release: manifest.release, images: Object.fromEntries(RELEASE_IMAGE_NAMES.map((name) => [name, manifest.images[name]])), ...(manifest.product ? { product: manifest.product } : {}), digest: createHash("sha256").update(canonicalReleaseManifest(manifest)).digest("hex") })}`,
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
    // Compose resolves this overlay's paths against the first compose file's
    // directory, the configuration generation; the evidence sits beside the overlay.
    `    file: ../${PRIVACY_RELEASE_EVIDENCE_DIRECTORY}/${validationEvidenceFile}`,
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

import {
  DEFAULT_RELEASE_MANIFEST_REPOSITORY,
  imagePrefixOf,
  normalizeReleaseSelection,
  PRODUCT_VERSION_PATTERN,
  RELEASE_REPOSITORY_ENV,
  RELEASE_SELECTOR_ENV,
  type ReleaseSelection,
} from "./release-selection";

export {
  DEFAULT_RELEASE_MANIFEST_REPOSITORY,
  normalizeReleaseSelection,
  PRODUCT_VERSION_PATTERN,
  RELEASE_REPOSITORY_ENV,
  RELEASE_SELECTOR_ENV,
  type ReleaseSelection,
} from "./release-selection";

/**
 * The aggregate OpenMapX release manifest published by
 * `.github/workflows/docker.yml` as `<registry>/<namespace>/release-manifest:main`.
 * A configuration generation renders its image pins into its compose file and
 * keeps the manifest beside it, so the generation names its release.
 */

import { createHash } from "node:crypto";
import z from "zod/v4";

export const RELEASE_MANIFEST_CONTAINER_PATH = "/release-manifest.json";
/** Runtime services whose images a generation pins as one release. */
export const RELEASE_PINNED_SERVICE_IDS = [
  "app-api",
  "app-web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
] as const;
export const TRANSITOUS_TOOLS_IMAGE_ENV = "OPENMAPX_TRANSITOUS_TOOLS_IMAGE";

/** The six application images; documentation publishes independently. */
export const RELEASE_IMAGE_NAMES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
  "transitous-tools",
] as const;
const DIGEST = "sha256:[a-f0-9]{64}";
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
      { sourceRevision: string; inputHash: string; builtAt: string; coldRefreshedAt: string }
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
/** The newest database migration the release's API ships, from its migration journal. */
export interface ReleaseDatabaseMigrationHead {
  tag: string;
  /** The journal entry's `when`, which the migrator records as `created_at`. */
  when: number;
}
export interface ReleaseManifest {
  schemaVersion: 1;
  release: string;
  images: Record<(typeof RELEASE_IMAGE_NAMES)[number], string>;
  /** Display metadata: who built the release. Nothing is authorised from it. */
  producer: ReleaseProducer;
  /** Display metadata: how each image was built. Nothing is authorised from it. */
  buildMetadata: ReleaseBuildMetadata;
  product?: ProductReleaseMetadata;
  /** Absent in manifests published before CI recorded it; rollback then refuses. */
  databaseMigrationHead?: ReleaseDatabaseMigrationHead;
}

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
      coldRefreshedAt: z.iso.datetime({ offset: true }),
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
const databaseMigrationHeadSchema = z.strictObject({
  tag: z.string().regex(/^\d{4}_[a-z0-9_]{1,120}$/),
  when: z.number().int().positive().safe(),
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
    producer?: unknown;
    buildMetadata?: unknown;
    product?: unknown;
    databaseMigrationHead?: unknown;
  };
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported release lockfile schemaVersion");
  if (typeof candidate.release !== "string" || !RELEASE_ID_PATTERN.test(candidate.release)) {
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
  for (const [field, schema] of [
    ["producer", producerSchema],
    ["buildMetadata", buildMetadataSchema],
  ] as const) {
    if (!schema.safeParse(candidate[field]).success)
      throw new Error(`Release lockfile ${field} is invalid`);
  }
  if (candidate.product !== undefined && !productSchema.safeParse(candidate.product).success)
    throw new Error("Release lockfile product is invalid");
  if (
    candidate.databaseMigrationHead !== undefined &&
    !databaseMigrationHeadSchema.safeParse(candidate.databaseMigrationHead).success
  )
    throw new Error("Release lockfile databaseMigrationHead is invalid");
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

/** Stable bytes: what the manifest cache and a generation store, and what its digest covers. */
export function canonicalReleaseManifest(manifest: ReleaseManifest): string {
  return JSON.stringify({
    schemaVersion: 1,
    release: manifest.release,
    images: {
      api: manifest.images.api,
      web: manifest.images.web,
      "data-manager": manifest.images["data-manager"],
      "ops-agent": manifest.images["ops-agent"],
      "transitous-runner": manifest.images["transitous-runner"],
      "transitous-tools": manifest.images["transitous-tools"],
    },
    producer: stableObject(manifest.producer),
    buildMetadata: stableObject(manifest.buildMetadata),
    ...(manifest.product ? { product: stableObject(manifest.product) } : {}),
    ...(manifest.databaseMigrationHead
      ? {
          databaseMigrationHead: {
            tag: manifest.databaseMigrationHead.tag,
            when: manifest.databaseMigrationHead.when,
          },
        }
      : {}),
  });
}

/** The SHA-256 of the canonical manifest: the release's identity in generations and the cache. */
export function releaseManifestDigest(manifest: ReleaseManifest): string {
  return createHash("sha256").update(canonicalReleaseManifest(manifest)).digest("hex");
}

/** The image each pinned service runs in `manifest`. */
export function releaseServiceImages(
  manifest: ReleaseManifest,
): Readonly<Record<(typeof RELEASE_PINNED_SERVICE_IDS)[number], string>> {
  return {
    "app-api": manifest.images.api,
    "app-web": manifest.images.web,
    "data-manager": manifest.images["data-manager"],
    "ops-agent": manifest.images["ops-agent"],
    "transitous-runner": manifest.images["transitous-runner"],
  };
}

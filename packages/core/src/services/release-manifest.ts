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
import { CORE_SERVICE_ID, type ReleasePinnedServiceId } from "./core-service-ids";

export const RELEASE_MANIFEST_CONTAINER_PATH = "/release-manifest.json";

/** The five application images; documentation publishes independently. */
export const RELEASE_IMAGE_NAMES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
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
  const digest = matches[0]?.[1];
  if (matches.length !== 1 || digest === undefined)
    throw new Error("Docker pull did not return one unambiguous release manifest digest");
  return digest;
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

/**
 * The version of installation state this code reads and writes: generations,
 * agent and control records, the database baseline. A release that cannot take
 * over an installation's state in place raises it, and an installation refuses
 * a release of another epoch. Published releases carry it as `stateEpoch`.
 */
export const RELEASE_STATE_EPOCH = 1;

/** A release whose state epoch differs from this installation's. */
export class ReleaseStateEpochError extends Error {
  constructor(
    readonly release: string,
    readonly stateEpoch: number,
  ) {
    super(
      `Release ${release} uses installation state epoch ${stateEpoch}, and this installation uses epoch ${RELEASE_STATE_EPOCH}. It cannot be applied in place; follow that release's notes to install it fresh.`,
    );
    this.name = "ReleaseStateEpochError";
  }
}

/** Display metadata: who built the release. Nothing is authorised from it, so a
 * later release may add to it or change it. */
export type ReleaseProducer = Readonly<Record<string, unknown>>;
/** Display metadata: how each image was built. Nothing is authorised from it. */
export type ReleaseBuildMetadata = Readonly<Record<string, unknown>>;
/** A named product release. Only its version is read: a version selection must
 * match it. The rest is display metadata. */
export interface ProductReleaseMetadata {
  readonly version: string;
  readonly [field: string]: unknown;
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
  producer: ReleaseProducer;
  buildMetadata: ReleaseBuildMetadata;
  product?: ProductReleaseMetadata;
  databaseMigrationHead: ReleaseDatabaseMigrationHead;
  /** The release's installation state epoch; see {@link RELEASE_STATE_EPOCH}. */
  stateEpoch: number;
}

const displayMetadataSchema = z.looseObject({});
const productSchema = z.looseObject({
  version: z.string().refine((value) => PRODUCT_VERSION_PATTERN.test(`v${value}`)),
});
const databaseMigrationHeadSchema = z.strictObject({
  tag: z.string().regex(/^\d{4}_[a-z0-9_]{1,120}$/),
  when: z.number().int().positive().safe(),
});
const stateEpochSchema = z.number().int().positive().safe();
/** Keys in UTF-16 code-unit order, which no locale or runtime changes. */
function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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

/**
 * Reads a release manifest. Only what is authorised from it is strict: the
 * schema version, the release id, the five image references, the database
 * migration head and the state epoch. A release of another state epoch is
 * refused here, so `compose release --check`, the agent's release check, the
 * update preview (which reads the cached manifest) and the apply all refuse it.
 */
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
    stateEpoch?: unknown;
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
  for (const field of ["producer", "buildMetadata"] as const) {
    if (!displayMetadataSchema.safeParse(candidate[field]).success)
      throw new Error(`Release lockfile ${field} must be an object`);
  }
  if (candidate.product !== undefined && !productSchema.safeParse(candidate.product).success)
    throw new Error("Release lockfile product is invalid");
  if (!databaseMigrationHeadSchema.safeParse(candidate.databaseMigrationHead).success)
    throw new Error("Release lockfile databaseMigrationHead is missing or invalid");
  if (!stateEpochSchema.safeParse(candidate.stateEpoch).success)
    throw new Error("Release lockfile stateEpoch is missing or invalid");
  if (candidate.stateEpoch !== RELEASE_STATE_EPOCH)
    throw new ReleaseStateEpochError(candidate.release, candidate.stateEpoch as number);
  const product = candidate.product as ProductReleaseMetadata | undefined;
  if (product && candidate.release !== `v${product.version}`)
    throw new Error("Release product version does not match the release id");
  return {
    ...candidate,
    images: Object.fromEntries(RELEASE_IMAGE_NAMES.map((name) => [name, images[name]])),
  } as ReleaseManifest;
}

/**
 * Stable bytes: what the manifest cache and a generation store, and what its
 * digest covers. A top-level field this release does not know is kept, in key
 * order, after the known ones, so a later release reads back what it
 * published and computes the same digest. Images other than the five pinned
 * ones are dropped; a release that pins another image needs a new state epoch.
 *
 * Every later release must keep this layout: the eight fields above in this
 * order, then every other top-level field sorted by code unit, never in the
 * order fields were added. A release that reorders them changes the digest of
 * manifests that an older release reads, and needs a new state epoch.
 */
export function canonicalReleaseManifest(manifest: ReleaseManifest): string {
  const {
    schemaVersion: _schemaVersion,
    release: _release,
    images: _images,
    producer: _producer,
    buildMetadata: _buildMetadata,
    product: _product,
    databaseMigrationHead: _databaseMigrationHead,
    stateEpoch: _stateEpoch,
    ...later
  } = manifest as ReleaseManifest & Record<string, unknown>;
  return JSON.stringify({
    schemaVersion: 1,
    release: manifest.release,
    images: {
      api: manifest.images.api,
      web: manifest.images.web,
      "data-manager": manifest.images["data-manager"],
      "ops-agent": manifest.images["ops-agent"],
      "transitous-runner": manifest.images["transitous-runner"],
    },
    producer: stableObject(manifest.producer),
    buildMetadata: stableObject(manifest.buildMetadata),
    ...(manifest.product ? { product: stableObject(manifest.product) } : {}),
    databaseMigrationHead: {
      tag: manifest.databaseMigrationHead.tag,
      when: manifest.databaseMigrationHead.when,
    },
    stateEpoch: manifest.stateEpoch,
    ...(stableObject(later) as Record<string, unknown>),
  });
}

/** The SHA-256 of the canonical manifest: the release's identity in generations and the cache. */
export function releaseManifestDigest(manifest: ReleaseManifest): string {
  return createHash("sha256").update(canonicalReleaseManifest(manifest)).digest("hex");
}

/** The image each pinned service runs in `manifest`. */
export function releaseServiceImages(
  manifest: ReleaseManifest,
): Readonly<Record<ReleasePinnedServiceId, string>> {
  return {
    [CORE_SERVICE_ID.api]: manifest.images.api,
    [CORE_SERVICE_ID.web]: manifest.images.web,
    [CORE_SERVICE_ID.dataManager]: manifest.images["data-manager"],
    [CORE_SERVICE_ID.opsAgent]: manifest.images["ops-agent"],
    [CORE_SERVICE_ID.transitousRunner]: manifest.images["transitous-runner"],
  };
}

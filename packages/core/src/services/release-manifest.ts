/**
 * The aggregate OpenMapX release manifest published by
 * `.github/workflows/docker.yml` as `<registry>/<namespace>/release-manifest:latest`.
 * Parsing and overlay rendering are shared by the admin system updater
 * (apps/api) and the CLI so both produce byte-identical
 * `docker-compose.release.yml` overlays.
 */

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

const IMAGE_NAMES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
  "transitous-tools",
  "docs",
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
  images: Record<(typeof IMAGE_NAMES)[number], string>;
}

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
    throw new Error("Release manifest is not valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object") throw new Error("Release manifest must be an object");
  const candidate = value as { schemaVersion?: unknown; release?: unknown; images?: unknown };
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported release manifest schemaVersion");
  if (typeof candidate.release !== "string" || !candidate.release.trim()) {
    throw new Error("Release manifest release must be a non-empty string");
  }
  if (!candidate.images || typeof candidate.images !== "object") {
    throw new Error("Release manifest images must be an object");
  }
  const images = candidate.images as Record<string, unknown>;
  for (const name of IMAGE_NAMES) {
    const pattern = new RegExp(`^${escapeRegExp(imagePrefix)}/${escapeRegExp(name)}@${DIGEST}$`);
    const image = images[name];
    if (typeof image !== "string" || !pattern.test(image)) {
      throw new Error(
        `Release manifest images.${name} is not an approved immutable reference under ${imagePrefix}`,
      );
    }
  }
  return candidate as ReleaseManifest;
}

export function renderReleaseCompose(manifest: ReleaseManifest): string {
  return [
    "services:",
    "  app-api:",
    `    image: ${manifest.images.api}`,
    "  app-web:",
    `    image: ${manifest.images.web}`,
    "  data-manager:",
    `    image: ${manifest.images["data-manager"]}`,
    "    environment:",
    `      ${TRANSITOUS_TOOLS_IMAGE_ENV}: ${manifest.images["transitous-tools"]}`,
    "  ops-agent:",
    `    image: ${manifest.images["ops-agent"]}`,
    "  transitous-runner:",
    `    image: ${manifest.images["transitous-runner"]}`,
    "",
  ].join("\n");
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

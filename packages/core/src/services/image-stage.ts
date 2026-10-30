/** Resolve a configured reference to immutable cache input. Never retags an image. */
import { coordinatorPullReferenceIdentity } from "./coordinator-pull-reference";
export interface ImageStagePlatform {
  os: string;
  architecture: string;
  variant?: string;
}
export function imageStagePlatform(raw: string): ImageStagePlatform {
  const match = /^([a-z][a-z0-9]*)\/([a-z0-9_]+)(?:\/([a-z0-9]+))?$/.exec(raw.trim());
  if (!match || raw.length > 80) throw Error("Docker platform is unavailable");
  const aliases: Record<string, [string, string?]> = {
    x86_64: ["amd64"],
    aarch64: ["arm64"],
    armv7l: ["arm", "v7"],
    armv6l: ["arm", "v6"],
  };
  const [architecture, variant] = aliases[match[2]!] ?? [match[2]!, match[3]];
  return { os: match[1]!, architecture, ...(variant ? { variant } : {}) };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function immutableImageStageReference(
  reference: string,
  metadata: unknown,
  platform: ImageStagePlatform,
): string {
  const normalized = coordinatorPullReferenceIdentity(reference),
    pinned = normalized.indexOf("@");
  if (pinned !== -1) {
    if (!/^sha256:[a-f0-9]{64}$/.test(normalized.slice(pinned + 1)))
      throw Error("Unsupported immutable image digest");
    return normalized;
  }
  const values = Array.isArray(metadata) ? metadata : [metadata];
  if (values.length === 0 || values.length > 128)
    throw Error("Image manifest inventory exceeds its limit");
  const digests = new Set<string>();
  for (const value of values) {
    const descriptor = object(object(value).Descriptor),
      target = object(descriptor.platform);
    if (target.os !== platform.os || target.architecture !== platform.architecture) continue;
    const variant = target.variant ?? (target.architecture === "arm64" ? "v8" : undefined);
    if (
      platform.variant
        ? variant !== platform.variant
        : variant !== undefined && !(platform.architecture === "arm64" && variant === "v8")
    )
      continue;
    if (
      ![
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(String(descriptor.mediaType)) ||
      typeof descriptor.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)
    )
      throw Error("Image manifest descriptor is invalid");
    digests.add(descriptor.digest);
  }
  if (digests.size !== 1)
    throw Error(
      digests.size
        ? "Image platform manifest is ambiguous"
        : "No compatible image manifest is available",
    );
  const slash = normalized.lastIndexOf("/"),
    colon = normalized.lastIndexOf(":"),
    repository = colon > slash ? normalized.slice(0, colon) : normalized;
  return `${repository}@${[...digests][0]}`;
}

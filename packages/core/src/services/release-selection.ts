/** Pure release selection shared by runtime validation and browser-safe schemas. */
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
export function imagePrefixOf(image: string): string {
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

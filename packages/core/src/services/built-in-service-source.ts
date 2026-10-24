import { join, resolve } from "node:path";

/** Where one set of built-in service manifests is read from. */
export interface BuiltInServiceManifestSource {
  /** The built-in service IDs, sorted. */
  readonly ids: readonly string[];
  /** The manifest file of one of `ids`. */
  manifestPath(id: string): string;
  /**
   * Whether these are the release's own copies, embedded in the runtime
   * bundle, rather than the checkout's `services/<id>/service.json`.
   */
  readonly embedded: boolean;
}

/** The checkout's own built-in manifests, `<rootDir>/services/<id>/service.json`. */
export function checkoutBuiltInServiceManifests(
  rootDir: string,
  ids: readonly string[],
): BuiltInServiceManifestSource {
  const servicesDir = join(resolve(rootDir), "services");
  return {
    ids: [...ids].sort(),
    manifestPath: (id) => join(servicesDir, id, "service.json"),
    embedded: false,
  };
}

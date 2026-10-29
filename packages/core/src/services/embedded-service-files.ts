/** One file a built-in service's mounts name, as the runtime bundle embeds it. */
export interface EmbeddedServiceFile {
  serviceId: string;
  /** Relative to the service's directory, `/`-separated. */
  path: string;
  executable: boolean;
  url: URL;
}

export interface EmbeddedServiceFiles {
  files: readonly EmbeddedServiceFile[];
  /** `services/service-file-history.json`: every version each file had in a release. */
  history: URL;
}

/**
 * The release's built-in service files embedded in this process's runtime
 * bundle, or `null` when it runs from source, where they are the checkout's.
 *
 * The ops-agent's runtime bundle replaces this module with
 * `embedded-service-files.bundle.ts`, which `pnpm generate:service-files`
 * writes from the manifests (scripts/build-runtime-bundles.mjs).
 */
export function embeddedBuiltInServiceFiles(): EmbeddedServiceFiles | null {
  return null;
}

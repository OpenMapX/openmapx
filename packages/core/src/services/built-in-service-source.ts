import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Where one set of built-in manifests is read from. */
export interface BuiltInManifestSource {
  /** The built-in IDs, sorted. */
  readonly ids: readonly string[];
  /** The manifest file of one of `ids`. */
  manifestPath(id: string): string;
  /**
   * Whether these are the release's own copies, embedded in the runtime
   * bundle, rather than the checkout's.
   */
  readonly embedded: boolean;
}

/** Where one set of built-in service manifests is read from. */
export type BuiltInServiceManifestSource = BuiltInManifestSource;

/** The checkout's own built-in manifests, `<rootDir>/services/<id>/service.json`. */
export function checkoutBuiltInServiceManifests(
  rootDir: string,
  ids: readonly string[],
): BuiltInManifestSource {
  const servicesDir = join(resolve(rootDir), "services");
  return {
    ids: [...ids].sort(),
    manifestPath: (id) => join(servicesDir, id, "service.json"),
    embedded: false,
  };
}

const INTEGRATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The checkout's own built-in integration manifests: every
 * `<rootDir>/integrations/<id>/manifest.json`, skipping `_`-prefixed
 * templates and placeholders.
 */
export function checkoutBuiltInIntegrationManifests(rootDir: string): BuiltInManifestSource {
  const integrationsDir = join(resolve(rootDir), "integrations");
  const ids = existsSync(integrationsDir)
    ? readdirSync(integrationsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            INTEGRATION_ID.test(entry.name) &&
            existsSync(join(integrationsDir, entry.name, "manifest.json")),
        )
        .map((entry) => entry.name)
        .sort()
    : [];
  return {
    ids,
    manifestPath: (id) => join(integrationsDir, id, "manifest.json"),
    embedded: false,
  };
}

/**
 * The bytes of a regular file of 2 to `maxBytes` bytes, opened without
 * following a symbolic link. Throws otherwise, with the open's `code` when the
 * file is missing.
 */
export function readRegularFileBytes(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) {
      throw new Error("invalid");
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("invalid");
      offset += read;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error("invalid");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

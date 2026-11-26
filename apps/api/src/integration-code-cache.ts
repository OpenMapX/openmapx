import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isComponentId } from "@openmapx/core/component-id";

export interface IntegrationCodeCache {
  readonly root: string;
  /**
   * Writes verified bundle bytes to `<root>/<integrationId>/<sha256>/index.mjs`
   * and returns the absolute path to import.
   */
  materialize(integrationId: string, sha256: string, bytes: Buffer): string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function defaultRoot(): string {
  return (
    process.env.OPENMAPX_INTEGRATION_CODE_CACHE_DIR ?? join(tmpdir(), "openmapx-integration-code")
  );
}

function packageRoot(entry: string, name: string): string {
  let directory = dirname(entry);
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      if (parsed.name === name) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No package root named ${name} above ${entry}`);
    directory = parent;
  }
}

/**
 * The host directories a bundle's bare `@openmapx/integration-sdk` and `zod`
 * imports must reach. Node resolves bare specifiers upward from the importing
 * file and follows symlinks to real paths, so links to these directories give
 * the bundle the host's own module instances, error classes and registries.
 */
function hostPackageDirectories(): { sdk: string; zod: string } {
  const require = createRequire(import.meta.url);
  const sdk = realpathSync(dirname(require.resolve("@openmapx/integration-sdk/package.json")));
  const zodEntry = createRequire(join(sdk, "package.json")).resolve("zod");
  return { sdk, zod: realpathSync(packageRoot(zodEntry, "zod")) };
}

/**
 * Deletes and recreates the cache root, so code from an earlier boot is never
 * imported, and links the host packages bundles import into its `node_modules`.
 */
export function prepareIntegrationCodeCache(options: { root?: string } = {}): IntegrationCodeCache {
  const root = options.root ?? defaultRoot();
  const packages = hostPackageDirectories();

  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const scope = join(root, "node_modules", "@openmapx");
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  symlinkSync(packages.sdk, join(scope, "integration-sdk"), "dir");
  symlinkSync(packages.zod, join(root, "node_modules", "zod"), "dir");

  return {
    root,
    materialize(integrationId, sha256, bytes) {
      if (!isComponentId(integrationId)) {
        throw new Error(`Invalid integration id ${JSON.stringify(integrationId)}`);
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (!SHA256_HEX.test(sha256) || actual !== sha256) {
        throw new Error(`Bundle for ${integrationId} does not match its recorded SHA-256`);
      }
      const directory = join(root, integrationId, sha256);
      const path = join(directory, "index.mjs");
      if (existsSync(path) && readFileSync(path).equals(bytes)) return path;

      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const partial = join(directory, `.index.mjs.${process.pid}.partial`);
      rmSync(partial, { force: true });
      writeFileSync(partial, bytes, { mode: 0o400, flag: "wx" });
      renameSync(partial, path);
      return path;
    },
  };
}

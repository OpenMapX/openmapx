import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  type ReleaseServiceFiles,
  readOwnedRegularFile,
  serviceFileReferences,
  sha256,
} from "./release-service-files";
import type { LoadedService } from "./types";

/**
 * How the checkout's built-in services differ from the selected release's,
 * for the host CLI. It runs the checkout's code and manifests, so a host
 * render would otherwise let the checkout decide what runs; until the host
 * CLI runs from the release's image, it refuses instead.
 *
 * A service file that differs but has an override is fine: render uses the
 * override, not the checkout's file. One a container writes (valhalla.json)
 * is never compared.
 */
export interface CheckoutDifference {
  /** Relative to the checkout. */
  readonly path: string;
  readonly reason: string;
}

const TRAEFIK_ROUTES = "traefik/config/dynamic/generated-routes.yml";

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function checkoutDifferencesFromRelease(options: {
  rootDir: string;
  /** The built-in services the checkout has, as the host CLI loaded them. */
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  overrides: ReadonlyMap<string, Buffer>;
  uid?: number;
}): CheckoutDifference[] {
  const { rootDir, release, overrides } = options;
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const servicesDir = join(rootDir, "services");
  const differences: CheckoutDifference[] = [];
  const compare = (key: string, expected: string) => {
    const read = readOwnedRegularFile(join(servicesDir, key), uid);
    if ("reason" in read) {
      differences.push({
        path: `services/${key}`,
        reason: read.reason === "it is missing" ? "missing" : `can't be read: ${read.reason}`,
      });
    } else if (sha256(read.bytes) !== expected) {
      differences.push({ path: `services/${key}`, reason: "changed" });
    }
  };
  for (const [id, hash] of [...release.manifests].sort(([a], [b]) => a.localeCompare(b))) {
    compare(`${id}/service.json`, hash);
  }
  const builtIns = options.services.filter((service) => service.isBuiltIn);
  for (const service of builtIns) {
    if (!release.manifests.has(service.manifest.id)) {
      differences.push({ path: `services/${service.manifest.id}`, reason: "not in this release" });
    }
  }
  const references = serviceFileReferences(builtIns.map((service) => service.manifest));
  const written = new Set(
    references
      .filter((reference) => reference.writableCopy)
      .map((reference) => `${reference.serviceId}/${reference.path}`),
  );
  for (const [key, file] of release.files) {
    if (written.has(key) || overrides.has(key)) continue;
    compare(key, file.sha256);
  }
  // A file the checkout adds to a directory the release ships.
  const visit = (key: string) => {
    const stats = lstatOrUndefined(join(servicesDir, key));
    if (!stats?.isDirectory()) return;
    for (const name of readdirSync(join(servicesDir, key)).sort()) {
      if (name.startsWith(".")) continue;
      const child = `${key}/${name}`;
      if (lstatOrUndefined(join(servicesDir, child))?.isDirectory()) visit(child);
      else if (!release.files.has(child) && !overrides.has(child) && child !== TRAEFIK_ROUTES) {
        differences.push({ path: `services/${child}`, reason: "not in this release" });
      }
    }
  };
  for (const reference of references) visit(`${reference.serviceId}/${reference.path}`);
  return differences;
}

/** Why a host render refuses, and what the operator can do. */
export function describeCheckoutDifferences(
  differences: readonly CheckoutDifference[],
  release: { name: string | null; revision: string | null },
): string {
  const shown = differences.slice(0, 20).map((entry) => `  ${entry.path} (${entry.reason})`);
  if (differences.length > shown.length)
    shown.push(`  and ${differences.length - shown.length} more`);
  const built = release.revision ? `, built from ${release.revision}` : "";
  const checkout = release.revision
    ? `git checkout ${release.revision}`
    : "git checkout <its source revision>";
  return [
    `The checkout's built-in services differ from the selected release ${release.name ?? "(unknown)"}${built}:`,
    ...shown,
    "A host render runs this checkout's code and service manifests, so they must be the release's. Either wait until the release of this checkout's commit is published and run `pnpm openmapx compose release` again, or check out the selected release's source: " +
      `${checkout}. To keep a change to a service file, put the whole file in infra/docker/overrides/services/<id>/<path>; the operations agent, which runs the release's own files, applies it too.`,
  ].join("\n");
}

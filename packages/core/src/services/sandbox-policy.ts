import { checkManifestSandbox } from "@openmapx/extension-contracts/service";
import type { LoadedService } from "./types";

export {
  COMMUNITY_SAFE_CAPS,
  checkManifestSandbox,
  isComposeVarReference,
} from "@openmapx/extension-contracts/service";

/**
 * Cross-service and on-disk rules that need the whole registry and a real
 * filesystem. Throws on violation. Called by the renderer, which is the last
 * gate before a compose file is written.
 */
export function assertRenderSandbox(service: LoadedService, allServices: LoadedService[]): void {
  const staticErrors = checkManifestSandbox(service.manifest, {
    firstParty: service.isBuiltIn,
  });
  if (staticErrors.length) {
    throw new Error(
      `Service "${service.manifest.id}" failed sandbox validation: ${staticErrors.join("; ")}`,
    );
  }

  if (service.isBuiltIn) return;

  const taken = new Map<string, string>();
  for (const other of allServices) {
    if (other.manifest.id === service.manifest.id) continue;
    taken.set(other.manifest.id, `service "${other.manifest.id}"`);
    for (const alias of other.manifest.container.networkAliases ?? []) {
      taken.set(alias, `network alias on service "${other.manifest.id}"`);
    }
  }
  for (const alias of service.manifest.container.networkAliases ?? []) {
    if (alias === service.manifest.id) continue;
    const owner = taken.get(alias);
    if (owner) {
      throw new Error(
        `network alias "${alias}" on third-party service "${service.manifest.id}" collides with ${owner}`,
      );
    }
  }

  const otherVolumeNames = new Map<string, string>();
  for (const other of allServices) {
    if (other.manifest.id === service.manifest.id) continue;
    for (const volume of other.manifest.volumes ?? []) {
      otherVolumeNames.set(volume.name, other.manifest.id);
    }
  }
  for (const volume of service.manifest.volumes ?? []) {
    const owner = otherVolumeNames.get(volume.name);
    if (owner) {
      throw new Error(
        `volume "${volume.name}" on third-party service "${service.manifest.id}" is already declared by service "${owner}"`,
      );
    }
  }
}

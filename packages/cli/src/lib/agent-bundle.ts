import { services as coreServices } from "@openmapx/core/server";

/**
 * Whether this is the CLI bundled into the operations agent's image. It
 * carries its release's manifests and must not take code, build contexts or
 * provenance from the host checkout, which is not the release it runs.
 */
export function runsFromAgentBundle(): boolean {
  return coreServices.embeddedBuiltInServiceManifests() !== null;
}

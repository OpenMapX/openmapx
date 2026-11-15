/** Read-only: the image the applied generation pins for a service. */
import { serviceImageReferenceSchema } from "@openmapx/extension-contracts/service";
import { JSON_SCHEMA, load } from "js-yaml";
import { readAppliedRelease } from "./configuration-generation";
import {
  RELEASE_PINNED_SERVICE_IDS,
  releaseChannel,
  releaseServiceImages,
} from "./release-manifest";

export function configurationImageReference(composeYaml: string, serviceId: string) {
  const document = load(composeYaml, { schema: JSON_SCHEMA }) as {
    services?: Record<string, { image?: unknown }>;
  };
  return serviceImageReferenceSchema.parse(document?.services?.[serviceId]?.image);
}

/**
 * The pinned image of a release service in the applied generation, and the
 * digest of the release manifest that pins it (`releaseSelectionDigest`). A
 * release service without a pin is refused unless release resolution is
 * disabled; other services have neither.
 */
export function readServiceReleaseImageSelection(infraDir: string, serviceId: string) {
  if (!(RELEASE_PINNED_SERVICE_IDS as readonly string[]).includes(serviceId))
    return { imageReference: null, releaseSelectionDigest: null };
  const release = readAppliedRelease(infraDir);
  if (!release) {
    if (releaseChannel().kind === "disabled")
      return { imageReference: null, releaseSelectionDigest: null };
    throw new Error("The applied generation pins no release; select one with compose release");
  }
  return {
    imageReference: releaseServiceImages(release.manifest)[
      serviceId as (typeof RELEASE_PINNED_SERVICE_IDS)[number]
    ],
    releaseSelectionDigest: release.manifestDigest,
  };
}

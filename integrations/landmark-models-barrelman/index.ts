import type { IntegrationContext } from "@openmapx/integration-framework";
import { createOpenLandmarksProvider } from "@openmapx/open-landmarks-client/provider";
import { normalizeBarrelmanAsset } from "./normalize";

/** Barrelman Landmarks: CC0 low-poly landmark models placed from OpenStreetMap. */
export async function setup(ctx: IntegrationContext): Promise<void> {
  createOpenLandmarksProvider(ctx, {
    id: "landmark-models-barrelman",
    sourceIds: ["barrelman-landmarks", "openstreetmap"],
    baseUrl: "https://landmarks.barrelman.dev",
    channel: "latest",
    // Barrelman's deploys do not keep the previous release's files.
    retainsReleases: false,
    normalize: normalizeBarrelmanAsset,
  });
}

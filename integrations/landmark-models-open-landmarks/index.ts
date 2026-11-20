import type { IntegrationContext } from "@openmapx/integration-framework";
import { createOpenLandmarksProvider } from "@openmapx/open-landmarks-client/provider";
import { normalizeOpenLandmarksAsset } from "./normalize";

/**
 * Open Landmarks: per-model licensed landmark models. The preview channel is
 * read so models whose rights are cleared appear even before their geometry
 * review; the normalizer drops every model whose rights review has not passed.
 */
export async function setup(ctx: IntegrationContext): Promise<void> {
  createOpenLandmarksProvider(ctx, {
    id: "landmark-models-open-landmarks",
    sourceIds: ["open-landmarks", "openstreetmap"],
    baseUrl: "https://open-landmarks.benmaps.fr",
    channel: "preview",
    retainsReleases: true,
    normalize: normalizeOpenLandmarksAsset,
  });
}

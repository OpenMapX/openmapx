import {
  type Camera,
  type CameraProvider,
  type CameraQuery,
  createSiteOrchestrator,
  type IntegrationContext,
  type SiteOrchestrator,
} from "@openmapx/integration-framework";

/**
 * Every camera provider (domain `cameras`) merged behind one search and one
 * read by id; see `createSiteOrchestrator`.
 */
export function createCameraOrchestrator(
  ctx: IntegrationContext,
): SiteOrchestrator<CameraProvider, Camera, CameraQuery> {
  return createSiteOrchestrator<CameraProvider, Camera, CameraQuery>(ctx, {
    domain: "cameras",
    logPrefix: "webcam",
    search: {
      name: "searchCameras",
      run: async (p, bbox, query) => {
        const { cameras, partial } = await p.searchCameras(bbox, query);
        return partial ? { sites: cameras, partial } : { sites: cameras };
      },
    },
    get: { name: "getCamera", run: (p, id, query) => p.getCamera(id, query) },
  });
}

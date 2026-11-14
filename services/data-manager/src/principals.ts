import type { dataManagerOperations } from "@openmapx/core/data-manager-contracts";

/** The callers that hold a data-manager token, each its own. */
export const DATA_MANAGER_PRINCIPALS = ["api", "ops-agent", "host-cli"] as const;
export type DataManagerPrincipal = (typeof DATA_MANAGER_PRINCIPALS)[number];

/**
 * Whether the API's token reaches each route. The API faces the network and
 * reaches only the routes behind the admin panel, the map and the offline
 * packages. The operations agent and the host CLI reach every route: each
 * can read every token file anyway, the agent through the secrets directory it
 * mounts and the host CLI on the host. Routes reached without a bearer token
 * are listed as false; the auth hook lets them through before it asks.
 */
export const DATA_MANAGER_API_ROUTES: {
  readonly [K in keyof typeof dataManagerOperations]: boolean;
} = {
  startDataExecution: true,
  startGenerationHardlinksExecution: false,
  recoverUnadmittedGenerationHardlinks: false,
  prepareDataConfigurationFence: false,
  recoverUnadmittedConfigurationPreparation: false,
  inspectDataConfigurationFence: false,
  settleDataConfigurationFence: false,
  lookupDataExecution: true,
  getDataExecution: true,
  cancelDataExecution: true,
  getAmbientPlacesStatus: true,
  buildAmbientPlaces: true,
  resumeAmbientPlaces: true,
  discardAmbientPlaces: true,
  setAmbientPlacesEnabled: true,
  rollbackAmbientPlaces: true,
  getCoverageEvidence: true,
  getOfflinePackageCapability: true,
  prepareOfflinePackage: true,
  getOfflinePackageJob: true,
  getOfflinePackageManifest: true,
  getOfflineGlyphCatalog: true,
  headOfflineGlyph: true,
  getOfflineGlyph: true,
  headOfflinePackageArchive: true,
  getOfflinePackageArchive: true,
  getLive: false,
  getTransitOperatorFeed: false,
  getStatus: false,
  getDatasets: true,
  getTransitProfile: true,
  getTransitSources: true,
  addTransitSource: true,
  getTransitCatalog: true,
  removeTransitSource: true,
  enableTransitSource: true,
  disableTransitSource: true,
  preflightTransit: false,
  reloadDatasets: false,
  bakePredictedTraffic: false,
  getAppliedTrafficConditions: true,
  getPlannedTrafficClosures: true,
  getSearchIndexStatus: true,
  getNotablePlacesStatus: true,
  link: false,
  getOvertureRecovery: true,
  getOvertureStatus: true,
  inspectTransitSyncPreflight: true,
  syncTransit: true,
  restartMotis: true,
  inspectCatalogReview: true,
  proposeTransitBump: true,
  approveTransitBump: false,
};

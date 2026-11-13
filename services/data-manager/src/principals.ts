import type { dataManagerOperations } from "@openmapx/core/data-manager-contracts";

/** The callers that hold a data-manager token, each its own. */
export const DATA_MANAGER_PRINCIPALS = ["api", "ops-agent", "host-cli"] as const;
export type DataManagerPrincipal = (typeof DATA_MANAGER_PRINCIPALS)[number];

const api = "api";
const agent = "ops-agent";
const cli = "host-cli";

/**
 * Which caller may use each route. The operations agent runs the fixed CLI
 * with its own token, so it may use every route the host CLI may, plus the
 * configuration fence and the generation hardlinks it drives itself. The API
 * reaches only the routes behind the admin panel, the map and the offline
 * packages. An operator inspects the applied traffic set with the host CLI's
 * token. Routes reached without a bearer token list no caller.
 */
export const DATA_MANAGER_ROUTE_PRINCIPALS: {
  readonly [K in keyof typeof dataManagerOperations]: readonly DataManagerPrincipal[];
} = {
  startDataExecution: [api, agent, cli],
  startGenerationHardlinksExecution: [agent, cli],
  recoverUnadmittedGenerationHardlinks: [agent, cli],
  prepareDataConfigurationFence: [agent],
  recoverUnadmittedConfigurationPreparation: [agent],
  inspectDataConfigurationFence: [agent],
  settleDataConfigurationFence: [agent],
  lookupDataExecution: [api, agent, cli],
  getDataExecution: [api, agent, cli],
  cancelDataExecution: [api, agent, cli],
  getAmbientPlacesStatus: [api],
  buildAmbientPlaces: [api],
  resumeAmbientPlaces: [api],
  discardAmbientPlaces: [api],
  setAmbientPlacesEnabled: [api],
  rollbackAmbientPlaces: [api],
  getCoverageEvidence: [api],
  getOfflinePackageCapability: [api],
  prepareOfflinePackage: [api],
  getOfflinePackageJob: [api],
  getOfflinePackageManifest: [api],
  getOfflineGlyphCatalog: [api],
  headOfflineGlyph: [api],
  getOfflineGlyph: [api],
  headOfflinePackageArchive: [api],
  getOfflinePackageArchive: [api],
  getLive: [],
  getTransitOperatorFeed: [],
  getStatus: [],
  getDatasets: [api, agent, cli],
  getTransitProfile: [api],
  getTransitSources: [api, agent, cli],
  addTransitSource: [api, agent, cli],
  getTransitCatalog: [api],
  removeTransitSource: [api, agent, cli],
  enableTransitSource: [api, agent, cli],
  disableTransitSource: [api, agent, cli],
  preflightTransit: [agent, cli],
  reloadDatasets: [agent, cli],
  bakePredictedTraffic: [agent, cli],
  getAppliedTrafficConditions: [api, agent, cli],
  getPlannedTrafficClosures: [api, agent, cli],
  getSearchIndexStatus: [api, agent, cli],
  getNotablePlacesStatus: [api, agent, cli],
  link: [agent, cli],
  getOvertureRecovery: [api],
  getOvertureStatus: [api, agent, cli],
  inspectTransitSyncPreflight: [api],
  syncTransit: [api, agent, cli],
  restartMotis: [api],
  inspectCatalogReview: [api],
  proposeTransitBump: [api, agent, cli],
  approveTransitBump: [agent, cli],
};

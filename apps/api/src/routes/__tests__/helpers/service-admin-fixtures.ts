import type { AdminServiceSelection } from "@openmapx/core/api-contracts";
import type { OpsResultFor } from "@openmapx/core/ops";

export const serviceSelectionFixture: AdminServiceSelection = {
  source: "file",
  selectedRoots: [],
  requestedIds: [],
  effectiveIds: [],
  warnings: [],
  missingIds: [],
  envVarName: "OPENMAPX_SERVICES",
  envVarValue: null,
  selectionFilePath: "/synthetic/selection.json",
};
export const serviceDataFixture: OpsResultFor<"data.inspect"> = {
  osm: { items: [], total: 0, limit: 50, offset: 0, unavailable: false },
  builds: [
    {
      target: "valhalla",
      built: false,
      readiness: "missing",
      reason: "No prepared output",
      sizeBytes: null,
      sourceFingerprints: [],
      buildRecordVersion: null,
      region: null,
      runtimeImages: {},
    },
  ],
  motisTransitous: {
    configFound: false,
    datasetCount: 0,
    realtimeFeedCount: 0,
    gbfsFeedCount: 0,
    feedProxyUrlCount: 0,
    gbfsProxyUrl: null,
    feedProxyMode: "none",
    feedProxyConfigFound: false,
    feedProxyVarsFound: false,
    feedProxyFeedCount: 0,
    capabilityState: "missing",
    activeEpoch: null,
    candidateEpoch: null,
    testedAt: null,
    configHash: null,
    licenseHash: null,
    rentalProviderCount: 0,
    rentalProviderGroupCount: 0,
    rollbackAvailable: false,
    operationsProfile: "unknown",
    activeSlot: null,
    previousHealthySlot: null,
    preflightState: "missing",
    preflightRequiredDiskBytes: null,
    preflightFreeDiskBytes: null,
    pinProposalPending: false,
    crowdsourceState: "disabled-pending-review",
    gbfsCatalog: {
      state: "missing",
      commit: null,
      lockedAt: null,
      registryRows: 0,
      registryAdded: 0,
      transitousPreferred: 0,
      quarantined: 0,
      validationFailed: 0,
      sources: [],
    },
  },
};
export const serviceHardlinksFixture = {
  applied: true,
  linked: 1,
  skipped: 2,
  pruned: 3,
  entries: 6,
  via: "ops-agent",
};
export function serviceFixture(id = "motis") {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      description: "Synthetic service",
      quality: "built-in" as const,
      container: { image: "example/service", tag: "1.0.0" },
      provides: ["routing"],
    },
    directory: `/synthetic/${id}`,
    enabled: true,
    isBuiltIn: true,
  };
}

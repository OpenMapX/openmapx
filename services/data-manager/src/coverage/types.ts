import type {
  AuthorityObservation,
  CoverageReasonCode,
  CoverageRegion,
  RightsEvidence,
  StreamEvidence,
} from "@openmapx/core/coverage";

export interface DataManagerCoverageSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  collectionStatus: "complete" | "partial" | "unavailable";
  authorities: AuthorityObservation[];
  warnings: CoverageReasonCode[];
  regions: CoverageRegion[];
  streams: StreamEvidence[];
  /** Native rights assertions paired with service-owned publication streams. */
  rights?: RightsEvidence[];
  /** Number of streams observed before the bounded retention ceiling. */
  totalStreams: number;
  /** True when the 4 MiB evidence ceiling removed source rows. */
  truncated: boolean;
  unassignedSourceCount: number;
}

export interface DataManagerCoveragePage {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  evaluatedAt: string;
  collectionStatus: DataManagerCoverageSnapshot["collectionStatus"];
  authorities: AuthorityObservation[];
  warnings: CoverageReasonCode[];
  regions: CoverageRegion[];
  evidence: StreamEvidence[];
  /** Native rights assertions paired with service-owned publication streams. */
  rights?: RightsEvidence[];
  total: number;
  retainedTotal: number;
  truncated: boolean;
  unassignedSourceCount: number;
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
    snapshotId: string;
  };
}

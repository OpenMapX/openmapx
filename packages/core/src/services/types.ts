import type { ServiceManifest } from "@openmapx/extension-contracts/service";

export * from "@openmapx/extension-contracts/service";

export interface LoadedService {
  manifest: ServiceManifest;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
}

export interface IntegrationRequirement {
  service?: string;
  capability?: string;
  optional?: boolean;
}

export interface ResolutionMatch {
  serviceId: string;
  source: "exact-service" | "capability" | "git-url";
}

export interface ResolutionResult {
  satisfied: boolean;
  match?: ResolutionMatch;
  candidates?: string[];
  reason?: "ambiguous" | "no-providers" | "service-not-installed" | "service-disabled";
}

export type { DatasetMetadata, DatasetType } from "./data-manager/contracts/datasets";

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
  /** Producer-instance id for multi-instance datasets; undefined for the default/only instance. */
  instance?: string;
  /** Stable target filename requested by the consumer, if any. */
  targetFilename?: string;
}

export interface RenderResult {
  composeYaml: string;
  hardlinkPlan: HardlinkEntry[];
  /**
   * Non-fatal render-time advisories surfaced for the operator (CLI prints
   * them; admin API forwards them). Today this is populated when an optional
   * bind-mount's host source is missing and the mount is therefore skipped.
   */
  warnings?: string[];
  /**
   * Absolute host paths of writable `@infra:data/...` bind-mount sources. The
   * deploy step pre-creates these (owned by the invoking, data-owning user)
   * before `docker compose up` so docker doesn't auto-create them as root —
   * which would block the non-root container (and the data-manager pipeline)
   * from writing into its own data dir.
   */
  writableBindDirs?: string[];
}

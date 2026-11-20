import type { ExecutionRef } from "../ops/execution-ref";

export interface TransitousLock {
  ref: string;
  submodules: Record<string, string>;
  lockedAt: string;
  lockedBy: string;
  comment?: string;
}
/** The transitland-atlas commit a Transitous lock pins; a lock without one is refused. */
export function pinnedAtlasCommit(lock: TransitousLock): string {
  const commit = lock.submodules["transitland-atlas"];
  if (!commit) throw new Error("Catalog pins have no transitland-atlas commit");
  return commit;
}
/** The Transitous commit after the `@` of a lock's `branch@sha` ref. */
export function pinnedTransitousCommit(lock: TransitousLock): string {
  const [, commit] = /@([0-9a-f]{40})$/.exec(lock.ref) ?? [];
  if (!commit) throw new Error("Catalog pins have no exact Transitous commit");
  return commit;
}
export interface GbfsCatalogLock {
  schemaVersion: 1;
  source: "mobilitydata-gbfs";
  commit: string;
  url: string;
  sha256: string;
  lockedAt: string;
  lockedBy: string;
}
export interface CatalogPinSet {
  schemaVersion: 1;
  generationId: string;
  transitous: TransitousLock;
  gbfs: GbfsCatalogLock;
}
export interface CatalogPinCommitIdentity {
  commitId: string;
  execution: ExecutionRef;
  proposalId: string;
  validationId: string;
  diffDigest: string;
}
export interface CatalogPinCommitReceipt {
  version: 1;
  identity: CatalogPinCommitIdentity;
  previousGenerationId: string | null;
  generationId: string;
  phase: "prepared" | "committed" | "not_committed" | "unknown";
  committedAt: string | null;
}
export function catalogRevisionId(pins: CatalogPinSet): string {
  return pins.generationId;
}

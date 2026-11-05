import type { ExecutionRef } from "../ops/execution-ref";

export interface TransitousLock {
  ref: string;
  submodules: Record<string, string>;
  lockedAt: string;
  lockedBy: string;
  comment?: string;
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

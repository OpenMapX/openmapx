import { createHash } from "node:crypto";

export const SEMANTIC_MODEL = "qwen3-embedding:0.6b" as const;
export const SEMANTIC_DIMENSIONS = 256 as const;
export const EMBEDDING_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_RESOLUTION_POLICY_VERSION = 1 as const;
export const SEMANTIC_PROVIDER_ID = "semantic-taxonomy" as const;
export const SEMANTIC_QUERY_INSTRUCTION =
  "Instruct: Map a user's map-search request to the single most relevant place category. " +
  "A specific place, address, brand, code, or request without a place type has no category.\n" +
  "Query: ";

export interface EmbeddingModelIdentity {
  provider: "ollama";
  model: typeof SEMANTIC_MODEL;
  digest: string;
  dimensions: typeof SEMANTIC_DIMENSIONS;
  embeddingSchemaVersion: typeof EMBEDDING_SCHEMA_VERSION;
}

export interface SemanticCalibration {
  version: 1;
  model: typeof SEMANTIC_MODEL;
  modelDigest: string;
  dimensions: typeof SEMANTIC_DIMENSIONS;
  embeddingSchemaVersion: typeof EMBEDDING_SCHEMA_VERSION;
  resolutionPolicyVersion: typeof SEMANTIC_RESOLUTION_POLICY_VERSION;
  behaviorChecksum: string;
  catalogChecksum: string;
  minimumScore: number;
  minimumMargin: number;
  activationConfidence: 0.55;
}

export function computeSemanticBehaviorChecksum(
  input: {
    dimensions?: number;
    embeddingSchemaVersion?: number;
    resolutionPolicyVersion?: number;
    queryInstruction?: string;
  } = {},
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        dimensions: input.dimensions ?? SEMANTIC_DIMENSIONS,
        embeddingSchemaVersion: input.embeddingSchemaVersion ?? EMBEDDING_SCHEMA_VERSION,
        resolutionPolicyVersion:
          input.resolutionPolicyVersion ?? SEMANTIC_RESOLUTION_POLICY_VERSION,
        queryInstruction: input.queryInstruction ?? SEMANTIC_QUERY_INSTRUCTION,
      }),
    )
    .digest("hex");
}

export const SEMANTIC_BEHAVIOR_CHECKSUM = computeSemanticBehaviorChecksum();

export type SemanticAbstentionReason =
  | "not-eligible"
  | "proper-name"
  | "brand"
  | "address-code"
  | "already-plausible"
  | "below-score"
  | "below-margin"
  | "selector-conflict";

export type SemanticUnavailableReason =
  | "disabled"
  | "service-absent"
  | "model-not-ready"
  | "timeout"
  | "overloaded"
  | "invalid-response"
  | "cache-error"
  | "calibration-mismatch";

export type SemanticResolutionOutcome =
  | { status: "matched"; categoryId: string; score: number; margin: number }
  | { status: "abstained"; reason: SemanticAbstentionReason }
  | { status: "unavailable"; reason: SemanticUnavailableReason };

export interface ScoredSemanticCategory {
  categoryId: string;
  score: number;
}

export interface SemanticScoreResult {
  top: ScoredSemanticCategory;
  second: ScoredSemanticCategory;
  margin: number;
}

export class SemanticEmbeddingError extends Error {
  constructor(
    readonly reason: SemanticUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = "SemanticEmbeddingError";
  }
}

import { PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY } from "./primary-source-stream.js";
import type { ReadinessImplementationCapabilities } from "./readiness.js";
import { PRIVACY_RECEIPT_PRESERVATION_CAPABILITY } from "./receipt-snapshot.js";
import {
  PRIVACY_ASSISTED_WORKFLOW_CAPABILITY,
  PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY,
} from "./request-service.js";

/** Capability facts are exported by the implementation that owns each
 * behavior. Runtime prerequisites remain separate operational checks. */
export const IMPLEMENTED_PRIVACY_RELEASE_CAPABILITIES = Object.freeze({
  preservationEnforced:
    PRIVACY_RECEIPT_PRESERVATION_CAPABILITY.durableEncryptedSnapshots &&
    PRIVACY_RECEIPT_PRESERVATION_CAPABILITY.boundedSafeProjections &&
    PRIVACY_RECEIPT_PRESERVATION_CAPABILITY.exactKeyRedisCapture &&
    PRIVACY_RECEIPT_PRESERVATION_CAPABILITY.noLiveFallback &&
    PRIVACY_RECEIPT_PRESERVATION_CAPABILITY.terminalCiphertextCleanup,
  boundedSourceStreaming:
    PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY.databaseCursor &&
    PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY.encryptedReplaySpool &&
    PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY.perRecordAndMemberBounds,
  assistedWorkflowComplete:
    PRIVACY_ASSISTED_WORKFLOW_CAPABILITY.authoritativeIdentityChallenge &&
    PRIVACY_ASSISTED_WORKFLOW_CAPABILITY.representativeAuthorityReview &&
    PRIVACY_ASSISTED_WORKFLOW_CAPABILITY.freshAuthenticatedDelivery,
  operatorTaskWorkflowAvailable:
    PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY.immutableDecisionEvents &&
    PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY.encryptedSupplements &&
    PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY.generationRequiresResolvedTasks,
} satisfies ReadinessImplementationCapabilities);

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PRIVACY_BACKUP_PROTOCOL_VERSION } from "@openmapx/core/ops";
import {
  DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
  DAWARICH_PROTOCOL_VERSION,
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
} from "@openmapx/core/privacy";
import { messages } from "@openmapx/i18n";
import { computePrivacySourceFingerprint } from "../../privacy-source-fingerprint.mjs";
import type { db as defaultDb } from "../db/index.js";
import {
  ARTIFACT_STATES,
  REQUEST_CHANNELS,
  REQUEST_KINDS,
  REQUEST_STATES,
  TASK_STATES,
} from "../db/privacy-schema.js";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import {
  PRIVACY_AAD_VERSION,
  PRIVACY_CIPHER_VERSION,
  PRIVACY_MASTER_KEY_RING_FORMAT_VERSION,
  PRIVACY_MASTER_KEY_RING_MAX_KEYS,
} from "./crypto.js";
import { PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY } from "./primary-source-stream.js";
import { PRIVACY_RECEIPT_PRESERVATION_CAPABILITY } from "./receipt-snapshot.js";
import { privacyImplementationActorIds } from "./release-identity.js";
import { type PrivacyReportLegalFacts, resolvePrivacyReportLegalFacts } from "./report-settings.js";
import {
  PRIVACY_ASSISTED_WORKFLOW_CAPABILITY,
  PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY,
} from "./request-service.js";

declare const __OPENMAPX_PRIVACY_SOURCE_FINGERPRINT__: string | undefined;

type JsonPrimitive = string | number | boolean | null;
export type ReleaseEvidenceValue =
  | JsonPrimitive
  | readonly ReleaseEvidenceValue[]
  | { readonly [key: string]: ReleaseEvidenceValue | undefined };

export interface PrivacyReleaseEvidenceInput {
  reviewLabel: string;
  sourceBuildFingerprint: string;
  catalogue: ReleaseEvidenceValue;
  collectorContracts: ReleaseEvidenceValue;
  canonicalPrivacyCopy: ReleaseEvidenceValue;
  crypto: ReleaseEvidenceValue;
  roles: ReleaseEvidenceValue;
  retention: ReleaseEvidenceValue;
  deployment: ReleaseEvidenceValue;
}

export interface PrivacyReleaseEvidence {
  version: string;
  controllerContactConfigured: boolean;
  sourceBuildFingerprint: string;
}

function canonical(value: ReleaseEvidenceValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  return `{${Object.entries(value)
    .filter((entry): entry is [string, ReleaseEvidenceValue] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
    .join(",")}}`;
}

/** One exact review target. Reusing the human label cannot preserve an
 * approval after any bound implementation, copy, contract or deployment fact changes. */
export function derivePrivacyReleaseEvidenceVersion(input: PrivacyReleaseEvidenceInput): string {
  if (!/^[a-f0-9]{64}$/.test(input.sourceBuildFingerprint))
    throw new Error("Invalid privacy source build fingerprint");
  const reviewLabel = input.reviewLabel.trim();
  if (!reviewLabel || reviewLabel.length > 128 || /[\p{Cc}]/u.test(reviewLabel))
    throw new Error("Invalid privacy review label");
  const digest = createHash("sha256")
    .update("openmapx/privacy/release-evidence/v1\0")
    .update(canonical({ ...input, reviewLabel }))
    .digest("hex");
  return `gdpr-release-v1.${digest}`;
}

function findSourceRoot(start = process.cwd()): string {
  let current = resolve(process.env.OPENMAPX_ROOT_DIR?.trim() || start);
  for (;;) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Privacy source root is unavailable");
    current = parent;
  }
}

export async function privacySourceBuildFingerprint(): Promise<string> {
  if (
    typeof __OPENMAPX_PRIVACY_SOURCE_FINGERPRINT__ !== "undefined" &&
    /^[a-f0-9]{64}$/.test(__OPENMAPX_PRIVACY_SOURCE_FINGERPRINT__)
  )
    return __OPENMAPX_PRIVACY_SOURCE_FINGERPRINT__;
  return computePrivacySourceFingerprint(findSourceRoot());
}

function backupRetentionDays(): number {
  const value = Number(process.env.BACKUP_RETENTION_DAYS?.trim() || "30");
  if (!Number.isSafeInteger(value) || value < 1 || value > 36_500)
    throw new Error("Invalid privacy backup retention configuration");
  return value;
}

function privacyCopy(): ReleaseEvidenceValue {
  return Object.fromEntries(
    Object.entries(messages).map(([locale, catalogue]) => [
      locale,
      (catalogue as { privacyExport?: ReleaseEvidenceValue }).privacyExport ?? null,
    ]),
  );
}

/** Algorithm and persistence contracts reviewed for every release. Deployment
 * key version numbers are runtime operational facts and intentionally excluded. */
export function privacyCryptoReleaseContract(): ReleaseEvidenceValue {
  return {
    aadVersion: PRIVACY_AAD_VERSION,
    artifactCipher: "aes-256-gcm",
    cipherVersion: PRIVACY_CIPHER_VERSION,
    keyDerivation: "hkdf-sha-256",
    keyRingFormatVersion: PRIVACY_MASTER_KEY_RING_FORMAT_VERSION,
    keyRingMaxKeys: PRIVACY_MASTER_KEY_RING_MAX_KEYS,
    keyWrappingCipher: "aes-256-gcm",
  };
}

async function deriveCurrentVersion(
  legalFacts: PrivacyReportLegalFacts | { configuration: "invalid" },
  sourceBuildFingerprint: string,
  reviewLabel: string,
): Promise<string> {
  const retention =
    "deployment" in legalFacts
      ? {
          artifactHours: legalFacts.deployment.exportArtifactRetentionHours,
          backupDays: backupRetentionDays(),
          caseDays: legalFacts.deployment.dsarCaseRetentionDays,
          identityEvidenceDays: legalFacts.deployment.identityEvidenceRetentionDays,
        }
      : { configuration: "invalid" as const };
  return derivePrivacyReleaseEvidenceVersion({
    reviewLabel,
    sourceBuildFingerprint,
    catalogue: SUBJECT_DATA_CATALOGUE,
    collectorContracts: {
      archiveManifest: 2,
      backupProtocol: PRIVACY_BACKUP_PROTOCOL_VERSION,
      boundedSourceStreaming: PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY,
      receiptPreservation: PRIVACY_RECEIPT_PRESERVATION_CAPABILITY,
      assistedWorkflow: PRIVACY_ASSISTED_WORKFLOW_CAPABILITY,
      operatorTaskWorkflow: PRIVACY_OPERATOR_TASK_WORKFLOW_CAPABILITY,
      managedDawarich: {
        protocol: DAWARICH_PROTOCOL_VERSION,
        schemaFingerprint: DAWARICH_EXPECTED_SCHEMA_FINGERPRINT,
        imageDigest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
        upstreamCommit: DAWARICH_SUPPORTED_COMMIT,
      },
    },
    canonicalPrivacyCopy: privacyCopy(),
    crypto: privacyCryptoReleaseContract(),
    roles: {
      approvalRole: "admin",
      privacyRole: "privacy_admin",
      implementationActorIds: privacyImplementationActorIds(),
      version: 1,
    },
    retention,
    deployment: {
      legalFacts:
        "deployment" in legalFacts
          ? {
              controller: { ...legalFacts.controller },
              deployment: {
                ...legalFacts.deployment,
                privacySources: legalFacts.deployment.privacySources.map((source) => ({
                  ...source,
                })),
              },
            }
          : legalFacts,
      artifactStorageBackupDisabled: process.env.PRIVACY_ARTIFACT_BACKUP_DISABLED === "true",
      backupCollectorImage: process.env.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE?.trim() || null,
      deploymentId: process.env.OPENMAPX_DEPLOYMENT_ID?.trim() || null,
      workflowStates: {
        artifacts: ARTIFACT_STATES,
        channels: REQUEST_CHANNELS,
        kinds: REQUEST_KINDS,
        requests: REQUEST_STATES,
        tasks: TASK_STATES,
      },
    },
  });
}

export async function resolvePrivacyReleaseEvidence(
  database: typeof defaultDb,
  options: {
    legalFacts?: PrivacyReportLegalFacts;
    sourceBuildFingerprint?: string;
    reviewLabel?: string;
  } = {},
): Promise<PrivacyReleaseEvidence> {
  const sourceBuildFingerprint =
    options.sourceBuildFingerprint ?? (await privacySourceBuildFingerprint());
  const reviewLabel =
    options.reviewLabel ?? (process.env.PRIVACY_EXPORT_EVIDENCE_VERSION?.trim() || "unreleased");
  try {
    const legalFacts = options.legalFacts ?? (await resolvePrivacyReportLegalFacts(database));
    return {
      version: await deriveCurrentVersion(legalFacts, sourceBuildFingerprint, reviewLabel),
      controllerContactConfigured: true,
      sourceBuildFingerprint,
    };
  } catch {
    return {
      version: await deriveCurrentVersion(
        { configuration: "invalid" },
        sourceBuildFingerprint,
        reviewLabel,
      ),
      controllerContactConfigured: false,
      sourceBuildFingerprint,
    };
  }
}

export async function resolvePrivacyReleaseEvidenceVersion(
  database: typeof defaultDb,
  options: Parameters<typeof resolvePrivacyReleaseEvidence>[1] = {},
): Promise<string> {
  return (await resolvePrivacyReleaseEvidence(database, options)).version;
}

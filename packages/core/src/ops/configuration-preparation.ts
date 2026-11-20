import {
  type PreparedConfigurationRecord,
  preparedConfigurationRecordSchema,
} from "./configuration-preparation-records";
import {
  isTrustedConfigurationApplyOperation,
  type OpsOperation,
  opsOperationSchema,
} from "./contract";
import { opsOperationFingerprint } from "./fingerprint";
import {
  type ConfigurationSnapshot,
  createConfigurationSnapshot,
  type TrustedConfigurationPayload,
  verifyConfigurationSnapshot,
} from "./trusted-config";

export * from "./configuration-preparation-records";

const MAX_RECORD_BYTES = 768 * 1024;

/** Names a candidate's generation and binds its apply operation to the payload digest. */
export function prepareConfigurationCandidate(
  options: Parameters<typeof createConfigurationSnapshot>[0] & {
    operationForRevision(revisionId: string, payloadDigest: string): OpsOperation;
  },
) {
  const snapshot = createConfigurationSnapshot(options);
  const operation = opsOperationSchema.parse(
    options.operationForRevision(snapshot.revisionId, snapshot.payloadDigest),
  );
  if (
    !isTrustedConfigurationApplyOperation(operation) ||
    operation.revisionId !== snapshot.revisionId ||
    operation.payloadDigest !== snapshot.payloadDigest
  )
    throw new Error("Prepared configuration unavailable");
  return {
    revisionId: snapshot.revisionId,
    operation,
    operationFingerprint: opsOperationFingerprint(operation),
    snapshot,
  };
}

/** Validates a prepared candidate read from storage or received from the API. */
export function inspectPreparedConfigurationRecord(value: unknown): {
  record: PreparedConfigurationRecord;
  payload: TrustedConfigurationPayload;
  snapshot: ConfigurationSnapshot & {
    operationFingerprint: string;
    issuedAtMs: number;
    expiresAtMs: number;
  };
} {
  if (Buffer.byteLength(JSON.stringify(value ?? null), "utf8") > MAX_RECORD_BYTES)
    throw new Error("Prepared configuration unavailable");
  const record = preparedConfigurationRecordSchema.parse(value);
  const operation = opsOperationSchema.parse(record.operation);
  const timing = verifyConfigurationSnapshot(record.snapshot, record.payload);
  if (
    record.snapshot.operationKey !== record.operationKey ||
    !isTrustedConfigurationApplyOperation(operation) ||
    operation.revisionId !== record.snapshot.revisionId ||
    operation.payloadDigest !== record.snapshot.payloadDigest
  )
    throw new Error("Prepared configuration unavailable");
  return {
    record,
    payload: record.payload,
    snapshot: {
      ...record.snapshot,
      operationFingerprint: opsOperationFingerprint(operation),
      ...timing,
    },
  };
}

import {
  inspectPreparedConfigurationRecord,
  type PreparedConfigurationRecord,
} from "@openmapx/core/ops";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

/**
 * Prepared configuration candidates live in the agent's own state; the API
 * hands them over and reads them back through typed agent operations.
 */
export async function retainConfigurationCandidate(record: PreparedConfigurationRecord) {
  await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.candidate.retain", record },
    createDurableOpsKey("configuration.candidate.retain", record.operationKey),
  );
}

async function read(lookup: { operationKey: string } | { candidateId: string }) {
  const { record } = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.candidate.read", lookup },
    createDurableOpsKey(
      "configuration.candidate.read",
      "operationKey" in lookup ? lookup.operationKey : lookup.candidateId,
    ),
  );
  return record ? inspectPreparedConfigurationRecord(record) : undefined;
}

export async function readConfigurationCandidate(operationKey: string) {
  const found = await read({ operationKey });
  if (!found) throw Error("Configuration candidate missing");
  return found;
}

export function findConfigurationCandidate(candidateId: string) {
  return read({ candidateId });
}

export async function discardConfigurationCandidate(operationKey: string): Promise<void> {
  await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.candidate.discard", operationKey },
    createDurableOpsKey("configuration.candidate.discard", operationKey),
  );
}

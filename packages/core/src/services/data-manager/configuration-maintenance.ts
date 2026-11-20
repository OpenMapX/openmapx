import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFencePrepareRequestSchema,
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleRequestSchema,
} from "./contracts/configuration-maintenance";
import type { DataControlDelegation } from "./contracts/executions";
import * as sdk from "./generated/data-manager.generated";
import { type DataManagerTransport, unwrapDataManagerResponse } from "./transport";

type ControlOptions = {
  transport: DataManagerTransport;
  delegation: DataControlDelegation;
  signal?: AbortSignal;
};
function boundedBody<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32 * 1024)
    throw Error("Configuration fence request exceeds budget");
  return value;
}
export async function prepareDataConfigurationFence(
  input: DataConfigurationFencePrepare,
  options: ControlOptions,
): Promise<DataConfigurationFenceReceipt> {
  const result = await sdk.prepareDataConfigurationFence(
    boundedBody(
      dataConfigurationFencePrepareRequestSchema.parse({
        ...input,
        delegation: options.delegation,
      }),
    ),
    { transport: options.transport, signal: options.signal },
  );
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}
export async function inspectDataConfigurationFence(
  maintenanceId: string,
  options: {
    transport: DataManagerTransport;
    candidateId: string;
    signal?: AbortSignal;
  },
): Promise<DataConfigurationFenceReceipt> {
  const result = await sdk.inspectDataConfigurationFence(
    maintenanceId,
    { candidateId: options.candidateId },
    { transport: options.transport, signal: options.signal },
  );
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}
/** Without a delegation the request is the operator's resolution, sent with the host CLI's token. */
export async function settleDataConfigurationFence(
  input: DataConfigurationFenceSettle,
  options: Omit<ControlOptions, "delegation"> & { delegation?: DataControlDelegation },
): Promise<DataConfigurationFenceReceipt> {
  const body = boundedBody(
    dataConfigurationFenceSettleRequestSchema.parse({
      ...input,
      ...(options.delegation ? { delegation: options.delegation } : {}),
    }),
  );
  const result = await sdk.settleDataConfigurationFence(body.maintenanceId, body, {
    transport: options.transport,
    signal: options.signal,
  });
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}

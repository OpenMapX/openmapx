import {
  type ConfigurationPrepareNonAdmission,
  configurationPrepareNonAdmissionSchema,
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleSchema,
} from "./contracts/configuration-maintenance";
import * as sdk from "./generated/data-manager.generated";
import { type DataManagerTransport, unwrapDataManagerResponse } from "./transport";

type ControlOptions = {
  transport: DataManagerTransport;
  controlAssertion: string;
  signal?: AbortSignal;
};
function boundedHeader(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096)
    throw Error("Invalid bounded control header");
  return value;
}
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
    boundedBody(dataConfigurationFencePrepareSchema.parse(input)),
    {
      transport: options.transport,
      signal: options.signal,
      headers: { "x-openmapx-control-delegation": boundedHeader(options.controlAssertion) },
    },
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
export async function recoverUnadmittedDataConfigurationFence(
  input: DataConfigurationFencePrepare,
  options: ControlOptions,
): Promise<ConfigurationPrepareNonAdmission> {
  const result = await sdk.recoverUnadmittedConfigurationPreparation(
    boundedBody(dataConfigurationFencePrepareSchema.parse(input)),
    {
      transport: options.transport,
      signal: options.signal,
      headers: { "x-openmapx-control-delegation": boundedHeader(options.controlAssertion) },
    },
  );
  return configurationPrepareNonAdmissionSchema.parse(unwrapDataManagerResponse(result));
}
/** Without a control assertion the request is the operator's resolution, sent with the host CLI's token. */
export async function settleDataConfigurationFence(
  input: DataConfigurationFenceSettle,
  options: Omit<ControlOptions, "controlAssertion"> & { controlAssertion?: string },
): Promise<DataConfigurationFenceReceipt> {
  const body = boundedBody(dataConfigurationFenceSettleSchema.parse(input));
  const result = await sdk.settleDataConfigurationFence(body.maintenanceId, body, {
    transport: options.transport,
    signal: options.signal,
    ...(options.controlAssertion === undefined
      ? {}
      : { headers: { "x-openmapx-control-delegation": boundedHeader(options.controlAssertion) } }),
  });
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}

import {
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
  options: { transport: DataManagerTransport; witness: string; signal?: AbortSignal },
): Promise<DataConfigurationFenceReceipt> {
  const result = await sdk.inspectDataConfigurationFence(maintenanceId, {
    transport: options.transport,
    signal: options.signal,
    headers: { "x-openmapx-configuration-fence-witness": boundedHeader(options.witness) },
  });
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}
export async function settleDataConfigurationFence(
  input: DataConfigurationFenceSettle,
  options: ControlOptions,
): Promise<DataConfigurationFenceReceipt> {
  const body = boundedBody(dataConfigurationFenceSettleSchema.parse(input));
  const result = await sdk.settleDataConfigurationFence(body.maintenanceId, body, {
    transport: options.transport,
    signal: options.signal,
    headers: { "x-openmapx-control-delegation": boundedHeader(options.controlAssertion) },
  });
  return dataConfigurationFenceReceiptSchema.parse(unwrapDataManagerResponse(result));
}

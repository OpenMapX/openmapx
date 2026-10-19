import type z from "zod/v4";
import { dataManagerOperations } from "./contracts";
import * as sdk from "./generated/data-manager.generated";
import { type DataManagerStreamLimits, readDataManagerNdjson } from "./stream-decoder";
import { DataManagerHttpError, type DataManagerRequestOptions } from "./transport";

export { type DataManagerStreamLimits, readDataManagerNdjson } from "./stream-decoder";

type StreamOperation =
  | "downloadOsm"
  | "convertOverpass"
  | "buildSearchIndex"
  | "buildNotablePlaces"
  | "pullOverture"
  | "syncOverture"
  | "ingestOverture"
  | "extractOverture"
  | "conflateOverture";
type StreamEvent<K extends StreamOperation> = z.output<
  (typeof dataManagerOperations)[K]["responses"][200]["schema"]
>;
type Progress<K extends StreamOperation> = Extract<StreamEvent<K>, { event: "progress" }>;
export type DataManagerProgressOptions<K extends StreamOperation> = DataManagerRequestOptions & {
  onProgress?: (event: Progress<K>) => void;
  streamLimits?: DataManagerStreamLimits;
};
async function consume<K extends StreamOperation>(
  operation: K,
  result: { status: number; stream?: Response; data?: unknown },
  options: DataManagerProgressOptions<K>,
) {
  if (!result.stream)
    throw new DataManagerHttpError(
      `Data-manager ${operation} HTTP ${result.status}`,
      result.status,
    );
  return readDataManagerNdjson<StreamEvent<K>>(
    result.stream,
    dataManagerOperations[operation].responses[200].schema as unknown as {
      parse(value: unknown): StreamEvent<K>;
    },
    options.onProgress,
    options.streamLimits,
  );
}

/** Small workflow adapters; URL/body/header serialization remains generated. */
export async function downloadOsmWithProgress(
  body: Parameters<typeof sdk.downloadOsm>[0],
  options: DataManagerProgressOptions<"downloadOsm">,
) {
  return consume("downloadOsm", await sdk.downloadOsm(body, options), options);
}
export async function convertOverpassWithProgress(
  body: Parameters<typeof sdk.convertOverpass>[0],
  options: DataManagerProgressOptions<"convertOverpass">,
) {
  return consume("convertOverpass", await sdk.convertOverpass(body, options), options);
}
export async function buildSearchIndexWithProgress(
  body: Parameters<typeof sdk.buildSearchIndex>[0],
  options: DataManagerProgressOptions<"buildSearchIndex">,
) {
  return consume("buildSearchIndex", await sdk.buildSearchIndex(body, options), options);
}
export async function buildNotablePlacesWithProgress(
  options: DataManagerProgressOptions<"buildNotablePlaces">,
) {
  return consume("buildNotablePlaces", await sdk.buildNotablePlaces(options), options);
}
export async function pullOvertureWithProgress(
  body: Parameters<typeof sdk.pullOverture>[0],
  options: DataManagerProgressOptions<"pullOverture">,
) {
  return consume("pullOverture", await sdk.pullOverture(body, options), options);
}
export async function syncOvertureWithProgress(
  body: Parameters<typeof sdk.syncOverture>[0],
  options: DataManagerProgressOptions<"syncOverture">,
) {
  return consume("syncOverture", await sdk.syncOverture(body, options), options);
}
export async function ingestOvertureWithProgress(
  body: Parameters<typeof sdk.ingestOverture>[0],
  options: DataManagerProgressOptions<"ingestOverture">,
) {
  return consume("ingestOverture", await sdk.ingestOverture(body, options), options);
}
export async function extractOvertureWithProgress(
  body: Parameters<typeof sdk.extractOverture>[0],
  options: DataManagerProgressOptions<"extractOverture">,
) {
  return consume("extractOverture", await sdk.extractOverture(body, options), options);
}
export async function conflateOvertureWithProgress(
  body: Parameters<typeof sdk.conflateOverture>[0],
  options: DataManagerProgressOptions<"conflateOverture">,
) {
  return consume("conflateOverture", await sdk.conflateOverture(body, options), options);
}

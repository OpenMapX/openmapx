import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureResultContributors,
  readCapturedContributors,
  snapshotContributors,
  withContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";

interface ResponseReceipt {
  contributors?: readonly Attribution[];
  attributions?: readonly Attribution[];
}

/** These response dependencies are captured before the query cache owns them. */
export function captureReachabilityContributors<
  T extends object,
  E extends ResponseReceipt & { data: T },
>(envelope: E) {
  const native = readCapturedContributors((envelope.data as ResponseReceipt).contributors);
  const receipts =
    native ??
    readCapturedContributors(envelope.contributors) ??
    snapshotContributors(envelope.attributions ?? []);
  const seeds = (envelope.data as { seeds?: unknown }).seeds;
  const data = Array.isArray(seeds)
    ? ({
        ...envelope.data,
        seeds: seeds.map((seed: Record<string, unknown>) => {
          const stop = seed.stop as { contributors?: unknown } | undefined;
          const own =
            readCapturedContributors(seed.contributors) ??
            readCapturedContributors(stop?.contributors);
          return withContributors(seed, own ?? captureResultContributors({}, receipts));
        }),
      } as T)
    : envelope.data;
  return { ...envelope, data: withContributors(data, receipts) };
}

export function captureIsochroneContributors<
  T extends { featureCollection: GeoJSON.FeatureCollection },
  E extends ResponseReceipt & { data: T },
>(envelope: E) {
  const captured = captureReachabilityContributors(envelope);
  const native =
    readCapturedContributors((envelope.data as ResponseReceipt).contributors) ??
    readCapturedContributors(envelope.contributors);
  return {
    ...captured,
    data: {
      ...captured.data,
      featureCollection: {
        ...envelope.data.featureCollection,
        features: envelope.data.featureCollection.features.map((feature) => {
          const own =
            readCapturedContributors(feature.properties?.contributors) ??
            readCapturedContributors(feature.properties?._mapAttributions);
          const receipts =
            own ?? native ?? captureResultContributors({}, captured.data.contributors);
          return withFeatureContributors(feature, receipts);
        }),
      },
    },
  };
}

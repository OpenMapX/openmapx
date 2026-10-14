import type { Review, ReviewAggregate, ReviewProvider } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { IntegrationContext } from "./context";
import { dataSourceToAttribution } from "./manifest";

/** Capture exact declared suppliers before each read, before any caller can cache the result. */
export function captureReviewProviderContributors(
  ctx: Pick<IntegrationContext, "manifest">,
  provider: ReviewProvider,
): ReviewProvider {
  const capture = () =>
    snapshotContributors((ctx.manifest.dataSources ?? []).map(dataSourceToAttribution));
  const stamp = <T extends Review | ReviewAggregate>(
    result: T,
    catalogue: readonly Attribution[],
  ): T => ({
    ...result,
    contributors:
      readCapturedContributors(result.contributors) ??
      snapshotContributors(
        catalogue.filter((receipt) => receipt.sourceId === (result.source || provider.id)),
      ),
  });
  return {
    id: provider.id,
    name: provider.name,
    async getReviews(subject, options) {
      const catalogue = capture();
      return (await provider.getReviews(subject, options)).map((review) =>
        stamp(review, catalogue),
      );
    },
    async getAggregate(subject, options) {
      const catalogue = capture();
      return stamp(await provider.getAggregate(subject, options), catalogue);
    },
    ...(provider.submit ? { submit: provider.submit.bind(provider) } : {}),
    ...(provider.uploadImage ? { uploadImage: provider.uploadImage.bind(provider) } : {}),
  };
}

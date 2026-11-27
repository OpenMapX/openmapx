import type { DirectionsResult, Route } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  type ContributingRecord,
  captureResultContributors,
  contributorsForRecords,
  type FieldContributors,
  readCapturedFieldContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { RoutingProvider } from "./contracts/routing-provider";

function captureRecord<
  T extends ContributingRecord & { fieldContributors?: FieldContributors; sourceIds?: string[] },
>(record: T, envelope: readonly Attribution[]): T {
  return {
    ...record,
    contributors: captureResultContributors(record, envelope),
    ...(record.fieldContributors === undefined
      ? {}
      : { fieldContributors: readCapturedFieldContributors(record.fieldContributors) }),
  };
}

function captureRoute(route: Route, envelope: readonly Attribution[]): Route {
  const captured = captureRecord(route, envelope);
  return {
    ...captured,
    legs: route.legs.map((leg) => ({
      ...captureRecord(leg, captured.contributors ?? []),
      steps: leg.steps.map((step) => captureRecord(step, captured.contributors ?? [])),
    })),
    steps: route.steps.map((step) => captureRecord(step, captured.contributors ?? [])),
  };
}

/** Built-in certificate for the exact backend used by this call. Capture the
 * named source metadata before acquisition, rather than consulting a catalogue
 * after the request finishes or a cached route is later displayed. Every
 * isochrone contour is credited to the whole captured set, since one engine
 * computed all of them from the same data.
 */
export function withRoutingContributors(
  provider: RoutingProvider,
  capture: () => readonly Attribution[],
): RoutingProvider {
  const captureResult = (
    result: DirectionsResult,
    envelope: readonly Attribution[],
  ): DirectionsResult => ({
    ...result,
    routes: result.routes.map((route) => captureRoute(route, envelope)),
  });
  const optimizeRoute = provider.optimizeRoute;
  const getMatrix = provider.getMatrix;
  const getIsochrone = provider.getIsochrone;
  return {
    ...provider,
    async getRoute(...args) {
      const envelope = snapshotContributors(capture());
      return captureResult(await provider.getRoute(...args), envelope);
    },
    ...(getMatrix
      ? {
          async getMatrix(...args: Parameters<NonNullable<RoutingProvider["getMatrix"]>>) {
            const envelope = snapshotContributors(capture());
            const rows = await getMatrix.apply(provider, args);
            return rows.map((row) =>
              row.map((cell) => (cell === null ? null : captureRecord(cell, envelope))),
            );
          },
        }
      : {}),
    ...(optimizeRoute
      ? {
          async optimizeRoute(...args: Parameters<NonNullable<RoutingProvider["optimizeRoute"]>>) {
            const envelope = snapshotContributors(capture());
            return captureResult(await optimizeRoute.apply(provider, args), envelope);
          },
        }
      : {}),
    ...(getIsochrone
      ? {
          async getIsochrone(...args: Parameters<NonNullable<RoutingProvider["getIsochrone"]>>) {
            const envelope = snapshotContributors(capture());
            const result = await getIsochrone.apply(provider, args);
            const contours = result.contours.map((contour) => ({
              ...contour,
              contributors: snapshotContributors(envelope),
            }));
            const contributors = contributorsForRecords(contours);
            return {
              ...result,
              contours,
              contributors,
              attributions: snapshotContributors(contributors),
            };
          },
        }
      : {}),
  };
}

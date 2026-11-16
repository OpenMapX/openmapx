import type { Translatable } from "@openmapx/integration-framework/strings";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForRecordFields } from "@openmapx/mobility-core/contributors";
import type { RouteStopFuelPrice } from "@/lib/navigation/useRouteFuelPrices";

/**
 * A fuel stop's price line: the fuel source's own label of the compared
 * grade's price and its age, "price unknown" when there is none, and nothing
 * while it is still being looked up.
 */
export function routeStopFuelPriceText(
  price: RouteStopFuelPrice | undefined,
  resolve: (value: Translatable | undefined) => string,
  unknown: string,
): string | undefined {
  if (price?.status === "priced") return resolve(price.result.labelSummary) || unknown;
  if (price?.status === "unknown") return unknown;
  return undefined;
}

/** The sources a shown price came from; none for an unknown or pending price. */
export function routeStopFuelPriceCredits(price: RouteStopFuelPrice | undefined): Attribution[] {
  return price?.status === "priced"
    ? contributorsForRecordFields(price.result, ["labelSummary"])
    : [];
}

import type { IntegrationContext } from "@openmapx/core";
import { CATEGORY_FILTERS, searchByCategory } from "@openmapx/core";

export function setup(ctx: IntegrationContext): void {
  ctx.registerProvider("poi-search", {
    id: "overpass",
    categories: Object.keys(CATEGORY_FILTERS),
    searchByCategory,
  });
}

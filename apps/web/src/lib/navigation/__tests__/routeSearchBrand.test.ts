import { brandToFilter } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { routeSearchQueryFor } from "../useRouteSearch";

describe("routeSearchQueryFor", () => {
  it("issues the same filter for a brand as the search bar does", () => {
    const brand = { qid: "Q41171", name: "Aldi", kind: ["brand" as const] };
    expect(routeSearchQueryFor({ brand })).toEqual({ filter: brandToFilter(brand) });
  });

  it("ORs the QID keys for a chain with more than one identity", () => {
    const brand = { qid: "Q1", name: "Multi", kind: ["brand" as const, "operator" as const] };
    const query = routeSearchQueryFor({ brand });
    expect(query.filter?.selectors).toHaveLength(2);
  });

  it("passes a category through unchanged", () => {
    expect(routeSearchQueryFor({ category: "fuel" })).toEqual({ category: "fuel" });
  });
});

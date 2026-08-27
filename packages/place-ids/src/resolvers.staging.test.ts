import { describe, expect, it } from "vitest";
import {
  beginPlaceResolverStaging,
  commitPlaceResolverStaging,
  getPlaceResolver,
  registerPlaceResolver,
  rollbackPlaceResolverStaging,
} from "./resolvers.js";

describe("place resolver generation staging", () => {
  it("keeps active resolvers visible until a staged generation commits", async () => {
    registerPlaceResolver("staging-commit-probe", async () => "old");

    beginPlaceResolverStaging();
    registerPlaceResolver("staging-commit-probe", async () => "new");

    expect(await getPlaceResolver("staging-commit-probe")?.("value", {})).toBe("old");

    commitPlaceResolverStaging();
    expect(await getPlaceResolver("staging-commit-probe")?.("value", {})).toBe("new");
  });

  it("discards staged resolver writes when a generation rolls back", async () => {
    registerPlaceResolver("staging-rollback-probe", async () => "old");

    beginPlaceResolverStaging();
    registerPlaceResolver("staging-rollback-probe", async () => "failed-generation");
    rollbackPlaceResolverStaging();

    expect(await getPlaceResolver("staging-rollback-probe")?.("value", {})).toBe("old");
  });
});

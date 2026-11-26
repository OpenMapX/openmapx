import { describe, expect, it } from "vitest";
import {
  beginPlaceResolverStaging,
  commitPlaceResolverStaging,
  getPlaceResolver,
  registerPlaceResolver,
  restorePlaceResolvers,
  rollbackPlaceResolverStaging,
  setPlaceResolverRegistrationGuard,
  snapshotPlaceResolvers,
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

describe("place resolver snapshots", () => {
  it("undoes registrations made after the snapshot in the live registry", async () => {
    registerPlaceResolver("snapshot-live-kept", async () => "kept");
    const snapshot = snapshotPlaceResolvers();
    registerPlaceResolver("snapshot-live-kept", async () => "replaced");
    registerPlaceResolver("snapshot-live-added", async () => "added");

    restorePlaceResolvers(snapshot);

    expect(await getPlaceResolver("snapshot-live-kept")?.("value", {})).toBe("kept");
    expect(getPlaceResolver("snapshot-live-added")).toBeUndefined();
  });

  it("acts on the staged registry while staging is active and leaves the live one alone", async () => {
    registerPlaceResolver("snapshot-staged-live", async () => "live");
    beginPlaceResolverStaging();
    try {
      registerPlaceResolver("snapshot-staged-kept", async () => "staged");
      const snapshot = snapshotPlaceResolvers();
      expect([...snapshot.keys()]).toEqual(["snapshot-staged-kept"]);
      registerPlaceResolver("snapshot-staged-added", async () => "added");

      restorePlaceResolvers(snapshot);
      commitPlaceResolverStaging();
    } catch (error) {
      rollbackPlaceResolverStaging();
      throw error;
    }

    expect(await getPlaceResolver("snapshot-staged-kept")?.("value", {})).toBe("staged");
    expect(getPlaceResolver("snapshot-staged-added")).toBeUndefined();
    expect(getPlaceResolver("snapshot-staged-live")).toBeUndefined();
  });
});

describe("place resolver registration guard", () => {
  it("ignores a registration the guard refuses and accepts it again once cleared", () => {
    setPlaceResolverRegistrationGuard((scheme) => scheme !== "guard-refused");
    try {
      registerPlaceResolver("guard-refused", async () => "refused");
      registerPlaceResolver("guard-accepted", async () => "accepted");
      expect(getPlaceResolver("guard-refused")).toBeUndefined();
      expect(getPlaceResolver("guard-accepted")).toBeTypeOf("function");
    } finally {
      setPlaceResolverRegistrationGuard(null);
    }
    registerPlaceResolver("guard-refused", async () => "accepted later");
    expect(getPlaceResolver("guard-refused")).toBeTypeOf("function");
  });
});

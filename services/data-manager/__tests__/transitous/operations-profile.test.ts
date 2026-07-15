import { describe, expect, it } from "vitest";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";

describe("MOTIS operations profiles", () => {
  it("resolves the default regional-assisted policy explicitly", () => {
    expect(resolveOperationsProfile({ countries: ["DE", "de"], source: "mirror" })).toMatchObject({
      profile: "regional-assisted",
      countries: ["de"],
      acquisition: "mirror",
      hostedRuntimeFallbackAllowed: true,
      gbfsSelection: "explicit-countries",
    });
  });

  it("never treats an empty regional scope as planet", () => {
    expect(() => resolveOperationsProfile({ countries: [] })).toThrow(/never means planet/);
  });

  it("requires a second planet confirmation", () => {
    expect(() => resolveOperationsProfile({ profile: "planet", source: "build" })).toThrow(
      /MOTIS_PLANET_CONFIRM/,
    );
    expect(
      resolveOperationsProfile({ profile: "planet", source: "build", confirmPlanet: true }),
    ).toMatchObject({ profile: "planet", experimental: true });
  });

  it("rejects hosted artifacts and mirror acquisition in sovereign mode", () => {
    expect(() =>
      resolveOperationsProfile({
        profile: "regional-sovereign",
        countries: ["de"],
        source: "mirror",
      }),
    ).toThrow(/origin build/);
    expect(() =>
      resolveOperationsProfile({
        profile: "regional-sovereign",
        countries: ["de"],
        source: "build",
        artifactBaseUrl: "https://api.transitous.org/gtfs/",
      }),
    ).toThrow(/prohibits Transitous/);
  });

  it("serializes only immutable, non-secret policy fields", () => {
    const policy = resolveOperationsProfile({
      profile: "regional-sovereign",
      countries: ["de"],
      source: "build",
      feedAllowList: ["de-bvg"],
      osmInput: "europe-germany.osm.pbf",
    });
    expect(JSON.stringify(policy)).not.toMatch(/token|password|secret/i);
    expect(policy).toMatchObject({
      originDownloadsRequired: true,
      hostedRuntimeFallbackAllowed: false,
      osmInput: "europe-germany.osm.pbf",
    });
  });
});

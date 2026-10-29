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

  it.each([
    "https://transitous.org/",
    "https://api.transitous.org:8443/gtfs/",
    "https://A.B.TRANSITOUS.ORG/gtfs/",
    "https://TRANSITOUS.ORG./gtfs/",
    "http://API.TRANSITOUS.ORG.:8080/gtfs/",
  ])("rejects the actual Transitous hostname in %s", (artifactBaseUrl) => {
    expect(() =>
      resolveOperationsProfile({
        profile: "regional-sovereign",
        countries: ["de"],
        source: "build",
        artifactBaseUrl,
      }),
    ).toThrow(/prohibits Transitous/);
  });

  it.each([
    "https://nottransitous.org/gtfs/",
    "https://nottransitous.org.:8443/gtfs/",
    "https://mirror-transitous.org/gtfs/",
    "https://transitous.org.example/gtfs/",
    "https://sub.transitous.org.example/gtfs/",
    "https://operator.example/transitous.org?next=https://api.transitous.org/",
    "https://transitous.org@operator.example:8443/gtfs/",
    "http://operator.example:8080/gtfs/",
  ])("allows unrelated artifact hostname in %s", (artifactBaseUrl) => {
    expect(
      resolveOperationsProfile({
        profile: "regional-sovereign",
        countries: ["de"],
        source: "build",
        artifactBaseUrl,
      }),
    ).toMatchObject({
      acquisition: "build",
      originDownloadsRequired: true,
      hostedRuntimeFallbackAllowed: false,
      artifactOrigins: [new URL(artifactBaseUrl).origin],
    });
  });

  it.each(["not a URL", "https://[bad", "https://"])(
    "fails closed for malformed artifact URL %s",
    (artifactBaseUrl) => {
      expect(() =>
        resolveOperationsProfile({
          profile: "regional-sovereign",
          countries: ["de"],
          source: "build",
          artifactBaseUrl,
        }),
      ).toThrow(/Invalid Transitous artifact URL/);
    },
  );

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

import { IntegrationRegistry } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { roadConditionAttributions } from "../attributions";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "../display";
import { situation } from "./fixtures";

const registry = new IntegrationRegistry([
  {
    id: "openconditions",
    enabled: true,
    domains: ["road-conditions"],
    dataSources: ["parent", "other", "unused"].map((sourceId) => ({
      sourceId,
      name: `Publisher ${sourceId}`,
      attribution: `Required credit ${sourceId}`,
      url: `https://${sourceId}.example`,
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    })),
  },
]);

describe("road incident contributor credits", () => {
  it("resolves only the contributing parent feed and retains publisher notices", () => {
    const credits = roadConditionAttributions(
      [
        situation({
          source: "child",
          attribution: { provider: "Child", sourceId: "parent", notice: "Required extra notice" },
        }),
      ],
      registry,
    );
    expect(credits).toEqual([
      {
        sourceId: "parent",
        name: "Publisher parent",
        url: "https://parent.example",
        spdxLicense: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        attributionText: "Required credit parent",
      },
      { sourceId: "parent", name: "Required extra notice" },
    ]);
  });

  it("falls back to a served event's credit when its source is outside the feed registry", () => {
    expect(
      roadConditionAttributions(
        [
          situation({
            source: "federated",
            attribution: {
              provider: "Remote publisher",
              license: "CC-BY-4.0",
              url: "https://remote.example/license",
            },
          }),
        ],
        registry,
      ),
    ).toEqual([
      {
        sourceId: "federated",
        name: "Remote publisher",
        spdxLicense: "CC-BY-4.0",
        licenseUrl: "https://remote.example/license",
      },
    ]);
  });

  it("snapshots every contributor on shared lines, with each marker's own contributor only", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [5, 52],
        [5.1, 52.1],
      ],
    };
    const groups = buildRoadConditionDisplayGroups([
      situation({ id: "a", source: "parent", geometry }),
      situation({ id: "b", source: "other", geometry }),
    ]);
    const features = buildRoadConditionFeatures(groups, "en", Date.now(), (events) =>
      roadConditionAttributions(events, registry),
    );
    const [markerA, markerB, line] = features;
    expect(
      JSON.parse(markerA!.properties!._mapAttributions).map(
        (c: { sourceId: string }) => c.sourceId,
      ),
    ).toEqual(["parent"]);
    expect(
      JSON.parse(markerB!.properties!._mapAttributions).map(
        (c: { sourceId: string }) => c.sourceId,
      ),
    ).toEqual(["other"]);
    expect(
      JSON.parse(line!.properties!._mapAttributions).map((c: { sourceId: string }) => c.sourceId),
    ).toEqual(["parent", "other"]);
  });
});

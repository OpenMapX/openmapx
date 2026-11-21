import { dataSourceToAttribution, IntegrationRegistry } from "@openmapx/integration-framework";
import { nth } from "@openmapx/integration-framework/testing";
import { assert, describe, expect, it } from "vitest";

/** A data source the registry fixture declares; the test fails if it is missing. */
function dataSource<T>(registry: { findDataSource(id: string): T | undefined }, id: string): T {
  const found = registry.findDataSource(id);
  assert.isDefined(found, `no ${id} data source`);
  return found;
}

import { roadConditionAttributions } from "../attributions";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "../display";
import { situation } from "./fixtures";

const registry = new IntegrationRegistry([
  {
    id: "openconditions",
    name: "OpenConditions",
    enabled: true,
    isBuiltIn: true,
    domains: ["road-conditions"],
    dataSources: ["parent", "other", "unused"].map((sourceId) => ({
      sourceId,
      name: `Publisher ${sourceId}`,
      attribution: `Required credit ${sourceId}`,
      url: `https://${sourceId}.example`,
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Data",
            license: {
              kind: "spdx",
              expression: "CC-BY-4.0",
              url: "https://creativecommons.org/licenses/by/4.0/",
            },
          },
        ],
      } as const,
      providerCountry: "DE",
      providerPrivacyUrl: "https://example.com/privacy",
    })),
  },
]);

describe("road incident contributor credits", () => {
  it("projects only the captured parent feed and retains publisher notices", () => {
    const credits = roadConditionAttributions([
      situation({
        source: "child",
        contributors: [
          dataSourceToAttribution(dataSource(registry, "parent")),
          { sourceId: "parent", name: "Required extra notice" },
        ],
        attribution: { provider: "Child", sourceId: "parent", notice: "Required extra notice" },
      }),
    ]);
    expect(credits).toEqual([
      {
        sourceId: "parent",
        name: "Publisher parent",
        url: "https://parent.example",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "CC-BY-4.0",
                url: "https://creativecommons.org/licenses/by/4.0/",
              },
            },
          ],
        } as const,
        attributionText: "Required credit parent",
      },
      { sourceId: "parent", name: "Required extra notice" },
    ]);
  });

  it("falls back to a served event's credit when its source is outside the feed registry", () => {
    expect(
      roadConditionAttributions([
        situation({
          source: "federated",
          attribution: {
            provider: "Remote publisher",
            licensing: {
              version: 1,
              bindings: [
                {
                  scope: "data",
                  subject: "Data",
                  license: {
                    kind: "spdx",
                    expression: "CC-BY-4.0",
                    url: "https://remote.example/license",
                  },
                },
              ],
            },
            url: "https://remote.example/license",
          },
        }),
      ]),
    ).toEqual([
      {
        sourceId: "federated",
        name: "Remote publisher",
        url: "https://remote.example/license",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "CC-BY-4.0",
                url: "https://remote.example/license",
              },
            },
          ],
        } as const,
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
      situation({
        id: "a",
        source: "parent",
        geometry,
        contributors: [dataSourceToAttribution(dataSource(registry, "parent"))],
      }),
      situation({
        id: "b",
        source: "other",
        geometry,
        contributors: [dataSourceToAttribution(dataSource(registry, "other"))],
      }),
    ]);
    const features = buildRoadConditionFeatures(groups, "en", Date.now(), (events) =>
      roadConditionAttributions(events),
    );
    const markerA = nth(features, 0);
    const markerB = nth(features, 1);
    const line = nth(features, 2);
    expect(
      JSON.parse(markerA.properties?._mapAttributions).map((c: { sourceId: string }) => c.sourceId),
    ).toEqual(["parent"]);
    expect(
      JSON.parse(markerB.properties?._mapAttributions).map((c: { sourceId: string }) => c.sourceId),
    ).toEqual(["other"]);
    expect(
      JSON.parse(line.properties?._mapAttributions).map((c: { sourceId: string }) => c.sourceId),
    ).toEqual(["parent", "other"]);
  });
});

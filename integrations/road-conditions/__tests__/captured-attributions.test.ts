import { projectEventsToRoute, roadConditionFeatureToEvent } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { roadConditionAttributions } from "../attributions";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "../display";
import { aggregateRoadConditions } from "../orchestrator";
import { situation } from "./fixtures";

const bbox: [number, number, number, number] = [4, 51, 6, 53];
const receipt = {
  sourceId: "parent",
  name: "Publisher",
  url: "https://old.test",
  attributionText: "Old required notice",
  publisher: { name: "Original publisher" },
};

function acquisition(native?: (typeof receipt)[], declared = false) {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const credit = structuredClone(receipt);
  const manifestSource = {
    sourceId: "parent",
    name: receipt.name,
    url: receipt.url,
    attribution: receipt.attributionText,
    licensing: licensingFromDeclaration("CC-BY-4.0", undefined),
  };
  const event = situation({
    source: "child",
    attribution: { provider: "Child", sourceId: "parent", notice: "Record notice" },
    ...(native === undefined ? {} : { contributors: native }),
  });
  const ctx = {
    getIntegrationsByDomain: () => [
      {
        id: "integration",
        manifest: { dataSources: declared ? [manifestSource] : [] },
        providers: new Map([
          [
            "road-conditions",
            [
              {
                id: "provider",
                async getEvents() {
                  started();
                  await pending;
                  return [event];
                },
              },
            ],
          ],
        ]),
      },
    ],
    ...(declared ? {} : { attributionIndex: { list: () => [credit], getById: () => credit } }),
    log: { warn() {} },
  } as unknown as IntegrationContext;
  return { ctx, credit, release, ready, event, manifestSource };
}

describe("captured incident receipts", () => {
  it("captures declared metadata under the producing integration even when the provider ID differs", async () => {
    const a = acquisition(undefined, true);
    const pending = aggregateRoadConditions(a.ctx, bbox);
    await a.ready;
    a.manifestSource.attribution = "Changed declared notice";
    a.release();
    expect((await pending)[0]?.contributors?.[0]?.attributionText).toBe("Old required notice");
  });
  it("does not invent a publisher for historical wire records with only a source ID", () => {
    const { geometry, ...properties } = situation({
      source: "parent-child",
      attribution: { provider: "" },
    });
    const event = roadConditionFeatureToEvent({ geometry, properties });
    expect(event).not.toBeNull();
    expect(roadConditionAttributions([event!])).toEqual([]);
  });
  it("retains native full and empty receipts when copied to navigation alerts", () => {
    for (const contributors of [[receipt], []]) {
      const event = situation({ contributors });
      const alerts = projectEventsToRoute(
        [event],
        [
          [4.99, 52],
          [5.01, 52],
        ],
        0,
      );
      expect(alerts).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(alerts))[0].contributors).toEqual(contributors);
    }
  });
  it("captures the exact parent before acquisition and preserves it through cached locale rebuilds", async () => {
    const a = acquisition();
    const pending = aggregateRoadConditions(a.ctx, bbox);
    await a.ready;
    a.credit.attributionText = "New notice";
    a.credit.publisher.name = "Replacement publisher";
    a.release();
    const events = await pending;
    const expected = [receipt, { sourceId: "parent", name: "Record notice" }];
    expect(events[0]?.contributors).toEqual(expected);
    for (const locale of ["en", "de"]) {
      const cached = JSON.parse(JSON.stringify(events));
      const features = buildRoadConditionFeatures(
        buildRoadConditionDisplayGroups(cached),
        locale,
        Date.now(),
        roadConditionAttributions,
      );
      expect(JSON.parse(features[0]!.properties!._mapAttributions)).toEqual(expected);
    }
  });

  it("preserves native empty receipts and never expands unknown historical records", async () => {
    const a = acquisition([]);
    const pending = aggregateRoadConditions(a.ctx, bbox);
    await a.ready;
    a.release();
    expect((await pending)[0]?.contributors).toEqual([]);
    expect(
      roadConditionAttributions([
        situation({ source: "parent-child", attribution: { provider: "" } }),
      ]),
    ).toEqual([]);
    expect(
      roadConditionAttributions([
        situation({ contributors: [], attribution: { provider: "Recorded", notice: "Ignored" } }),
      ]),
    ).toEqual([]);
  });
});

import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createOpenConditionsClient } from "../client.js";
import { setup } from "../index.js";
import type { LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import { readingToServiceVehicle } from "../vehicles/map.js";
import { createServiceVehicleProvider } from "../vehicles/provider.js";
import observationsResponse from "./fixtures/observations-vehicles.json" with { type: "json" };

/*
 * `observations-vehicles.json` is the `GET /observations/latest?property=vehicle.position` answer
 * for eight Digitraffic maintenance trackings, built from OpenConditions' own parser; see
 * fixtures/README.md.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [19, 59, 32, 71];
const FEED = "fi-digitraffic-maintenance";
/** Before the first of the eight positions expires. */
const NOW = new Date("2026-10-14T23:25:00Z");

type Body = { records: Rec[]; next: string | null };
const body = () => structuredClone(observationsResponse) as unknown as Body;

const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  crowd: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

function providerWith(
  answer: (req: FakeHttpRequest) => unknown,
  sources: LiveSources = EVERY_SOURCE,
  now = NOW,
) {
  const http = fakeHttpClient((req: FakeHttpRequest) =>
    req.url === `${BASE_URL}/observations/latest` ? answer(req) : undefined,
  );
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createServiceVehicleProvider(client, sources, { now: () => now }) };
}

describe("service-vehicles-openconditions", () => {
  test("reads the vehicle positions in effect, with their tasks and Harja's credit", async () => {
    const { http, provider } = providerWith(() => body());
    const { vehicles, partial } = await provider.searchVehicles(BBOX);

    expect(http.calls[0]?.options?.params).toMatchObject({
      bbox: BBOX.join(","),
      property: "vehicle.position",
      limit: 1000,
    });
    expect(partial).toBeUndefined();
    expect(vehicles).toHaveLength(8);
    const sanding = vehicles.find((v) => v.tasks.includes("SPOT_SANDING"))!;
    expect(sanding).toMatchObject({
      coordinates: [27.119327, 68.100155],
      spreaderOn: true,
      observedAt: "2026-10-14T23:20:45Z",
      expiresAt: "2026-10-14T23:30:45Z",
      sources: [FEED],
    });
    expect(sanding).not.toHaveProperty("activity");
    expect(sanding.attributions).toEqual([
      {
        sourceId: FEED,
        name: "Fintraffic Digitraffic road maintenance tracking",
        url: "https://www.digitraffic.fi/en/road-traffic/",
        licensing: expect.objectContaining({ version: 1 }),
        attributionText: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
      },
      expect.objectContaining({
        sourceId: FEED,
        name: "Fintraffic Digitraffic road maintenance tracking – Harja/Väylävirasto",
        publisher: { name: "Harja/Väylävirasto" },
      }),
    ]);
    expect(vehicles.find((v) => v.bearingDeg === 288)?.tasks).toEqual([
      "LEVELLING_OF_ROAD_SHOULDERS",
    ]);
  });

  test("reads a ploughing vehicle's blade and activity", () => {
    const [record] = body().records;
    const value = (record!.result as Rec).value as Rec;
    Object.assign(value, { activity: "plowing", plowUp: false, spreaderOn: true });
    (record!.extras as Rec).tasks = ["PLOUGHING_AND_SLUSH_REMOVAL", "SPOT_SANDING"];
    expect(readingToServiceVehicle(record!)).toMatchObject({
      activity: "plowing",
      plowDown: true,
      spreaderOn: true,
      tasks: ["PLOUGHING_AND_SLUSH_REMOVAL", "SPOT_SANDING"],
    });
  });

  test("leaves out an expired position, one of an excluded or unlisted source, and another property", async () => {
    const later = providerWith(() => body(), EVERY_SOURCE, new Date("2026-10-14T23:31:00Z"));
    expect((await later.provider.searchVehicles(BBOX)).vehicles.map((v) => v.observedAt)).toEqual([
      "2026-10-14T23:21:16Z",
      "2026-10-14T23:21:54.200Z",
    ]);
    const { provider } = providerWith(() => body());
    await expect(provider.searchVehicles(BBOX, { excludedSourceIds: [FEED] })).resolves.toEqual({
      vehicles: [],
    });
    const unlisted = providerWith(() => body(), { ...EVERY_SOURCE, has: () => false });
    await expect(unlisted.provider.searchVehicles(BBOX)).resolves.toEqual({ vehicles: [] });
    const [record] = body().records;
    expect(readingToServiceVehicle({ ...record!, property: "fire.frp" })).toBeNull();
  });

  test("reads every page, and says the area is partial when it stops at its cap", async () => {
    const pages = providerWith((req) => {
      const answer = body();
      return req.options?.params?.cursor === undefined
        ? { records: answer.records.slice(0, 4), next: "4" }
        : { records: answer.records.slice(4), next: null };
    });
    const { vehicles, partial } = await pages.provider.searchVehicles(BBOX);
    expect(vehicles).toHaveLength(8);
    expect(partial).toBeUndefined();
    expect(pages.http.calls[1]?.options?.params).toMatchObject({ cursor: "4" });

    const endless = providerWith(() => ({ records: [], next: "more" }));
    const capped = await endless.provider.searchVehicles(BBOX);
    expect(capped).toEqual({ vehicles: [], partial: "area" });
  });

  test("opens a searched position by reading the box around it, and none it never saw", async () => {
    const { http, provider } = providerWith(() => body());
    const { vehicles } = await provider.searchVehicles(BBOX);
    const target = vehicles[2]!;
    await expect(provider.getVehicle(target.id)).resolves.toMatchObject({ id: target.id });
    const box = String(http.calls[1]?.options?.params?.bbox).split(",").map(Number);
    expect(box[0]).toBeLessThan(target.coordinates[0]);
    expect(box[2]).toBeGreaterThan(target.coordinates[0]);
    await expect(provider.getVehicle("oc:observation:elsewhere:1")).resolves.toBeNull();
  });

  test("serves nothing until the source list arrives", async () => {
    const waiting = providerWith(() => body(), { ...EVERY_SOURCE, ready: false });
    await expect(waiting.provider.searchVehicles(BBOX)).resolves.toEqual({
      vehicles: [],
      partial: "unavailable",
    });
    await expect(waiting.provider.getVehicle("x")).resolves.toBeNull();
    expect(waiting.http.calls).toEqual([]);
  });

  test("fails on an answer that is no page of readings", async () => {
    const { provider } = providerWith(() => ({ error: "maintenance" }));
    await expect(provider.searchVehicles(BBOX)).rejects.toThrow(/Malformed/);
  });

  test("setup registers the service-vehicles provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.serviceVehicles.map((p) => p.id)).toEqual([
      "service-vehicles-openconditions",
    ]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.serviceVehicles).toEqual([]);
  });

  test("the data-flow disclosure names what vehicle positions send and receive", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const domain = strings.dataSources["domain:service-vehicles"];
      expect(domain.purpose).toBeTruthy();
      expect(domain.dataSent).toBeTruthy();
      expect(domain.dataReceived).toBeTruthy();
    }
  });
});

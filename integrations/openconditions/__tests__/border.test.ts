import type { BBox } from "@openmapx/core";
import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { recordToBorderCrossing } from "../border/map.js";
import { createBorderCrossingProvider } from "../border/provider.js";
import { createOpenConditionsClient } from "../client.js";
import type { LatestReading } from "../features/record.js";
import { setup } from "../index.js";
import type { LiveSources } from "../sources.js";
import stringsDe from "../strings/de.json" with { type: "json" };
import stringsEn from "../strings/en.json" with { type: "json" };
import featuresResponse from "./fixtures/features-border.json" with { type: "json" };

/*
 * `features-border.json` is the `GET /features?kind=border_crossing&canonical=1&expand=components,latest`
 * answer for five crossings, built from OpenConditions' own CBP and CBSA parsers and its canonical
 * view; see fixtures/README.md.
 */

type Rec = Record<string, unknown>;

const BASE_URL = "http://openconditions.test:4100";
const BBOX: BBox = [-110, 31, -67, 49.5];
/** Seven minutes after CBP's page. */
const NOW = new Date("2026-10-14T23:45:00Z");
const CBP = "us-cbp-waits";
const CBSA = "ca-cbsa-waits";

type Body = { records: Rec[]; latest: Record<string, LatestReading[]> };
const body = () => structuredClone(featuresResponse) as unknown as Body;
const named = (answer: Body, name: string) =>
  answer.records.find((r) => JSON.stringify(r.name).includes(`"${name}"`))!;

const EVERY_SOURCE: LiveSources = {
  ready: true,
  has: () => true,
  link: () => undefined,
  crowd: () => undefined,
  noticeOf: () => undefined,
  firmsSources: () => [],
};

function providerWith(answer: unknown, sources: LiveSources = EVERY_SOURCE) {
  const http = fakeHttpClient((req: FakeHttpRequest) =>
    req.url === `${BASE_URL}/features` ? answer : undefined,
  );
  const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
  return { http, provider: createBorderCrossingProvider(client, sources, { now: () => NOW }) };
}

function crossing(name: string, excluded?: (id: string) => boolean, now = NOW) {
  const answer = body();
  const record = named(answer, name);
  return recordToBorderCrossing(
    record,
    answer.latest[String(record.id)]!,
    excluded,
    undefined,
    now,
  );
}

describe("border-crossings-openconditions", () => {
  test("reads the canonical border crossings with every queue's wait", async () => {
    const { http, provider } = providerWith(body());
    const { crossings, partial } = await provider.searchCrossings(BBOX);

    expect(http.calls[0]?.options?.params).toMatchObject({
      bbox: BBOX.join(","),
      kind: "border_crossing",
      canonical: 1,
      expand: "components,latest",
    });
    expect(partial).toBeUndefined();
    expect(crossings.map((c) => c.name).sort()).toEqual([
      "Calais: Milltown",
      "Douglas (Raul Hector Castro)",
      "Emerson",
      "Peace Bridge",
      "Thousand Islands Bridge",
    ]);
  });

  test("one crossing both agencies publish carries both directions and both credits", () => {
    const peace = crossing("Peace Bridge")!;
    expect(peace).toMatchObject({
      coordinates: [-78.9056, 42.9069],
      countries: ["CA", "US"],
      location: "Fort Erie, ON/Buffalo, NY",
      open: "open",
      sources: [CBSA, CBP],
    });
    expect(peace.queues.map((q) => [q.key, q.from, q.to, q.status, q.waitMinutes])).toEqual([
      ["commercial", "US", "CA", "delay", 11],
      ["passenger", "US", "CA", "delay", 2],
      [`${CBP}/commercial/standard`, "CA", "US", "no_delay", 6],
      [`${CBP}/passenger/standard`, "CA", "US", "no_delay", 4],
      [`${CBP}/passenger/trusted_traveller`, "CA", "US", "no_delay", 0],
      [`${CBP}/passenger/ready_lane`, "CA", "US", "closed", undefined],
    ]);
    expect(peace.queues[3]).toMatchObject({
      mode: "passenger",
      program: "standard",
      lanesOpen: 1,
      updatedAt: "2026-10-14T23:27:00Z",
      stale: false,
    });
    expect(peace.attributions.map((a) => [a.sourceId, a.name])).toEqual([
      [CBSA, "CBSA border wait times"],
      [CBP, "CBP border wait times"],
    ]);
  });

  test("an excluded agency takes its queues, its status and its credit with it", () => {
    const peace = crossing("Peace Bridge", (id) => id === CBP)!;
    expect(peace.queues.map((q) => q.key)).toEqual(["commercial", "passenger"]);
    expect(peace.open).toBeUndefined();
    expect(peace.sources).toEqual([CBSA]);
    // The survivor's agency excluded, the crossing is not shown.
    expect(crossing("Peace Bridge", (id) => id === CBSA)).toBeNull();
  });

  test("a wait older than two hours is stale, and a closed crossing says so", () => {
    const islands = crossing("Thousand Islands Bridge")!;
    const intoUs = islands.queues.find((q) => q.key === `${CBP}/passenger/standard`)!;
    expect(intoUs).toMatchObject({ status: "no_delay", waitMinutes: 0, stale: true });
    expect(crossing("Calais: Milltown")).toMatchObject({
      open: "closed",
      openingHours: "08:00-16:00",
      queues: [{ key: "passenger/standard", status: "closed", stale: false }],
    });
    expect(crossing("Douglas (Raul Hector Castro)")).toMatchObject({
      countries: ["MX", "US"],
      openingHours: "24/7",
    });
  });

  test("a crossing closed for months is closed while the status's validity lasts", () => {
    const answer = body();
    const record = named(answer, "Calais: Milltown");
    const readings = answer.latest[String(record.id)]!.map((r) =>
      r.property === "facility.open_status"
        ? {
            ...r,
            phenomenonTime: { instant: "2026-03-02T12:00:00Z" },
            validUntil: "2026-10-15T00:08:05Z",
          }
        : r,
    );
    expect(recordToBorderCrossing(record, readings, undefined, undefined, NOW)?.open).toBe(
      "closed",
    );
    const unbounded = readings.map((r) => {
      if (r.property !== "facility.open_status") return r;
      const { validUntil: _validUntil, ...rest } = r;
      return rest;
    });
    expect(recordToBorderCrossing(record, unbounded, undefined, undefined, NOW)).not.toHaveProperty(
      "open",
    );
  });

  test("a status past its validity states nothing", () => {
    const later = crossing("Peace Bridge", undefined, new Date("2026-10-15T02:00:00Z"))!;
    expect(later.open).toBeUndefined();
    expect(later.queues.every((q) => q.stale)).toBe(true);
  });

  test("takes a crossing's hours from a member when the survivor states none", async () => {
    // CBSA survives the Peace Bridge cluster and states no hours; CBP's member states them.
    const perSource = {
      records: [
        {
          id: `oc:feature:${CBP}:090101`,
          kind: "border_crossing",
          provenance: { sourceId: CBP },
          openingHours: { osm: "24/7", twentyFourSeven: true, timezone: "America/New_York" },
        },
      ],
      next: null,
    };
    const http = fakeHttpClient((req: FakeHttpRequest) =>
      req.url === `${BASE_URL}/features`
        ? req.options?.params?.canonical === 0
          ? perSource
          : body()
        : undefined,
    );
    const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
    const provider = createBorderCrossingProvider(client, EVERY_SOURCE, { now: () => NOW });

    const { crossings } = await provider.searchCrossings(BBOX);
    const peace = crossings.find((c) => c.name === "Peace Bridge")!;
    expect(peace.openingHours).toBe("24/7");
    // Calais states its own hours and keeps them.
    expect(crossings.find((c) => c.name === "Calais: Milltown")?.openingHours).toBe("08:00-16:00");

    await expect(provider.getCrossing(peace.id)).resolves.toMatchObject({ openingHours: "24/7" });
    const withoutCbp = await provider.searchCrossings(BBOX, { excludedSourceIds: [CBP] });
    expect(withoutCbp.crossings.find((c) => c.name === "Peace Bridge")).not.toHaveProperty(
      "openingHours",
    );
  });

  test("a failed read of the members costs the hours, not the crossings", async () => {
    const http = fakeHttpClient((req: FakeHttpRequest) => {
      if (req.url !== `${BASE_URL}/features`) return undefined;
      if (req.options?.params?.canonical === 0) throw new Error("timeout");
      return body();
    });
    const client = createOpenConditionsClient({ OPENCONDITIONS_URL: BASE_URL }, http)!;
    const provider = createBorderCrossingProvider(client, EVERY_SOURCE, { now: () => NOW });
    const { crossings } = await provider.searchCrossings(BBOX);
    expect(crossings).toHaveLength(5);
  });

  test("serves nothing until the source list arrives, and nothing of a source it does not list", async () => {
    const waiting = providerWith(body(), { ...EVERY_SOURCE, ready: false });
    await expect(waiting.provider.searchCrossings(BBOX)).resolves.toEqual({
      crossings: [],
      partial: "unavailable",
    });
    await expect(waiting.provider.getCrossing("x")).resolves.toBeNull();
    const unlisted = providerWith(body(), { ...EVERY_SOURCE, has: () => false });
    await expect(unlisted.provider.searchCrossings(BBOX)).resolves.toEqual({ crossings: [] });
  });

  test("setup registers the border-crossings provider; none without OPENCONDITIONS_URL", async () => {
    const ctx = createMockIntegrationContext({ id: "openconditions" });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    expect(ctx.registered.borderCrossings.map((p) => p.id)).toEqual([
      "border-crossings-openconditions",
    ]);

    const bare = createMockIntegrationContext({ id: "openconditions" });
    await setup(bare, {});
    expect(bare.registered.borderCrossings).toEqual([]);
  });

  test("the data-flow disclosure names what crossings send and receive", () => {
    for (const strings of [stringsEn, stringsDe]) {
      const domain = strings.dataSources["domain:border-crossings"];
      expect(domain.purpose).toBeTruthy();
      expect(domain.dataSent).toBeTruthy();
      expect(domain.dataReceived).toBeTruthy();
    }
  });
});

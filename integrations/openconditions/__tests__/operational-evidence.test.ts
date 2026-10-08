import {
  createMockIntegrationContext,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, test } from "vitest";
import { createChargingSiteProvider } from "../charging/provider.js";
import { createOpenConditionsClient } from "../client.js";
import { createSiteEvidenceReader } from "../evidence/read.js";
import { createFuelStationProvider } from "../fuel/provider.js";
import { setup } from "../index.js";
import { createParkingSiteProvider } from "../parking/provider.js";
import { createRoadConditionsProvider } from "../road-conditions/provider.js";
import {
  createSourceScopes,
  type LiveSources,
  type OcSource,
  type SourceScope,
  type SourceScopes,
} from "../sources.js";
import coverageAnswer from "./fixtures/coverage.json" with { type: "json" };
import statusAnswer from "./fixtures/feeds-status.json" with { type: "json" };

/*
 * The fixtures follow the shapes OpenConditions serves: `coverage.json` is a
 * `GET /coverage` answer (`readCoverage` rows: live records per country,
 * subdivision, class, kind or property and access mode, with the sources
 * behind them) and `feeds-status.json` a `GET /feeds/status` answer (each
 * catalogue feed with its durable poll status). They are hand-built, not
 * recordings: an instance with every site domain configured. `SCOPES` is
 * what that instance's `/sources` list says of each source.
 */

const BASE_URL = "http://openconditions.test:4100";
const EVERY_SOURCE: LiveSources = { ready: true, has: () => true, link: () => undefined };

const SCOPES: Record<string, SourceScope> = {
  "de-bnetza-charging": { accessMode: "bulk", country: "DE" },
  "de-bw-mobidata-charging": { accessMode: "bulk", country: "DE", subdivision: "BW" },
  "ocm-charging": { accessMode: "on_demand" },
  "osm-charging": { accessMode: "on_demand" },
  "es-dgt-charging": { accessMode: "bulk", country: "ES" },
  "us-afdc-charging": { accessMode: "bulk", country: "US" },
  "de-bw-mobidata-parking": { accessMode: "bulk", country: "DE", subdivision: "BW" },
  "osm-parking": { accessMode: "on_demand" },
  "at-econtrol-fuel": { accessMode: "on_demand", country: "AT" },
  "de-tankerkoenig-fuel": { accessMode: "on_demand", country: "DE" },
  "fr-prixcarburants-fuel": { accessMode: "bulk", country: "FR" },
  "nl-ndw-events": { accessMode: "bulk", country: "NL" },
};

const scopesOf = (scopes: Record<string, SourceScope> = SCOPES): SourceScopes => ({
  ready: true,
  get: (id) => scopes[id],
});

type Responder = (req: FakeHttpRequest) => unknown;

const clone = <T>(value: T): T => structuredClone(value);

const answers =
  (coverage: unknown = clone(coverageAnswer), status: unknown = clone(statusAnswer)): Responder =>
  (req) => {
    if (req.url === `${BASE_URL}/coverage`) {
      if (coverage instanceof Error) throw coverage;
      return coverage;
    }
    if (req.url === `${BASE_URL}/feeds/status`) {
      if (status instanceof Error) throw status;
      return status;
    }
    return undefined;
  };

function readerWith(
  respond: Responder,
  env: NodeJS.ProcessEnv = { OPENCONDITIONS_URL: BASE_URL },
  scopes: SourceScopes = scopesOf(),
) {
  const http = fakeHttpClient(respond);
  const client = createOpenConditionsClient(env, http)!;
  return { http, client, reader: createSiteEvidenceReader(client, scopes) };
}

const byId = <T extends { sourceId: string }>(feeds: T[], id: string) =>
  feeds.find((feed) => feed.sourceId === id);

describe("site coverage evidence from OpenConditions", () => {
  test("maps the charging feeds with where their places and readings are", async () => {
    const { reader } = readerWith(answers());
    const evidence = await reader.read("charging");

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      instanceId: "oc-eu-1",
      collectedAt: "2026-10-06T10:00:00.000Z",
      truncated: false,
    });
    // Only the charging feeds, in the instance's order; the disabled one is never polled.
    expect(evidence.feeds.map((feed) => feed.sourceId)).toEqual([
      "de-bnetza-charging",
      "de-bw-mobidata-charging",
      "ocm-charging",
      "osm-charging",
      "es-dgt-charging",
      "us-afdc-charging",
    ]);
    expect(byId(evidence.feeds, "de-bw-mobidata-charging")).toMatchObject({
      name: "MobiData BW charging",
      lastAttemptAt: "2026-10-06T09:55:00.000Z",
      lastOutcome: "changed",
      lastSuccessfulCheckAt: "2026-10-06T09:55:00.000Z",
      lastPublicationAt: "2026-10-06T09:55:00.000Z",
      publicationRevision: "288",
      freshUntil: "2026-10-06T10:25:00.000Z",
      expectedIntervalSeconds: 300,
      activeEventCount: 5210,
      status: "healthy",
      action: null,
      // One subdivision of Germany: it holds DE in part. The tariffs (offers)
      // are neither the places nor readings about them.
      coverage: [
        {
          stream: "static",
          accessMode: "bulk",
          countries: ["DE"],
          whole: false,
          basis: "observed",
        },
        { stream: "live", accessMode: "bulk", countries: ["DE"], whole: false, basis: "observed" },
      ],
    });
    expect(byId(evidence.feeds, "de-bnetza-charging")?.coverage).toEqual([
      { stream: "static", accessMode: "bulk", countries: ["DE"], whole: true, basis: "observed" },
    ]);
    // A row shared by two on-demand sources counts for each of them, in part.
    expect(byId(evidence.feeds, "ocm-charging")?.coverage).toEqual([
      {
        stream: "static",
        accessMode: "on_demand",
        countries: ["DE"],
        whole: false,
        basis: "observed",
      },
    ]);
    expect(byId(evidence.feeds, "osm-charging")?.coverage).toEqual([
      {
        stream: "static",
        accessMode: "on_demand",
        countries: ["DE", "FR"],
        whole: false,
        basis: "observed",
      },
    ]);
  });

  test("holds a bulk feed's country in part when all its records there are in subdivisions", async () => {
    // The catalogue does not say so here; the records alone do.
    const { reader } = readerWith(
      answers(),
      undefined,
      scopesOf({ ...SCOPES, "de-bw-mobidata-charging": { accessMode: "bulk", country: "DE" } }),
    );
    const { feeds } = await reader.read("charging");

    expect(byId(feeds, "de-bw-mobidata-charging")?.coverage?.map((c) => c.whole)).toEqual([
      false,
      false,
    ]);
  });

  test("holds a subdivision feed's country in part when its records are filed under no subdivision", async () => {
    // OpenConditions files a record under a subdivision only when it can place
    // it in one; the catalogue's subdivision (from /sources) still limits the feed.
    const coverage = clone(coverageAnswer);
    for (const row of coverage.coverage) {
      if (row.sources.includes("de-bw-mobidata-charging")) row.subdivision = null;
    }
    const { reader } = readerWith(answers(coverage));
    const { feeds } = await reader.read("charging");

    expect(byId(feeds, "de-bw-mobidata-charging")?.coverage).toEqual([
      { stream: "static", accessMode: "bulk", countries: ["DE"], whole: false, basis: "observed" },
      { stream: "live", accessMode: "bulk", countries: ["DE"], whole: false, basis: "observed" },
    ]);
  });

  test("an on-demand feed holds the catalogue's coverage, a country list or a box", async () => {
    const { reader } = readerWith(
      answers(),
      undefined,
      scopesOf({
        ...SCOPES,
        "ocm-charging": { accessMode: "on_demand", countries: ["AT", "DE"] },
        "osm-charging": { accessMode: "on_demand", bbox: [-180, -90, 180, 90] },
      }),
    );
    const { feeds } = await reader.read("charging");

    // DE was fetched already; AT only declared.
    expect(byId(feeds, "ocm-charging")?.coverage).toEqual([
      {
        stream: "static",
        accessMode: "on_demand",
        countries: ["AT", "DE"],
        whole: false,
        basis: "declared",
      },
    ]);
    expect(byId(feeds, "osm-charging")?.coverage).toEqual([
      {
        stream: "static",
        accessMode: "on_demand",
        countries: ["DE", "FR"],
        whole: false,
        basis: "declared",
        bbox: [-180, -90, 180, 90],
      },
    ]);
  });

  test("an on-demand feed holds its catalogue country before any read fetched there", async () => {
    const { reader } = readerWith(answers());
    const { feeds } = await reader.read("fuel");

    expect(feeds.map((feed) => [feed.sourceId, feed.coverage])).toEqual([
      [
        "at-econtrol-fuel",
        [
          {
            stream: "static",
            accessMode: "on_demand",
            countries: ["AT"],
            whole: false,
            basis: "declared",
          },
        ],
      ],
      [
        "de-tankerkoenig-fuel",
        [
          {
            stream: "static",
            accessMode: "on_demand",
            countries: ["DE"],
            whole: false,
            basis: "observed",
          },
          {
            stream: "live",
            accessMode: "on_demand",
            countries: ["DE"],
            whole: false,
            basis: "observed",
          },
        ],
      ],
      [
        "fr-prixcarburants-fuel",
        [
          {
            stream: "static",
            accessMode: "bulk",
            countries: ["FR"],
            whole: true,
            basis: "observed",
          },
          {
            stream: "live",
            accessMode: "bulk",
            countries: ["FR"],
            whole: true,
            basis: "observed",
          },
        ],
      ],
    ]);
    // Revision 0 is a feed that never published.
    expect(byId(feeds, "at-econtrol-fuel")?.publicationRevision).toBeNull();
  });

  test("keeps a failing or unconfigured feed, with no records and its state", async () => {
    const { reader } = readerWith(answers());
    const { feeds } = await reader.read("charging");

    expect(byId(feeds, "es-dgt-charging")).toMatchObject({
      lastOutcome: "failed",
      lastSuccessfulCheckAt: null,
      publicationRevision: null,
      consecutiveFailures: 3,
      status: "failed",
      action: "investigate_poll_failures",
      coverage: [],
    });
    expect(byId(feeds, "us-afdc-charging")).toMatchObject({
      status: "missing_configuration",
      action: "configure_credentials",
      coverage: [],
    });
  });

  test("judges a place feed without the segment graph roads bind to", async () => {
    const status = clone(statusAnswer);
    status.graph = { generation: null, status: "missing", regions: [] } as never;
    const { reader } = readerWith(answers(clone(coverageAnswer), status));
    const { feeds } = await reader.read("charging");

    expect(byId(feeds, "de-bw-mobidata-charging")).toMatchObject({
      status: "healthy",
      action: null,
    });
  });

  test("maps the parking feeds", async () => {
    const { reader } = readerWith(answers());
    const parking = await reader.read("parking");

    expect(parking.feeds.map((feed) => [feed.sourceId, feed.coverage])).toEqual([
      [
        "de-bw-mobidata-parking",
        [
          {
            stream: "static",
            accessMode: "bulk",
            countries: ["DE"],
            whole: false,
            basis: "observed",
          },
          {
            stream: "live",
            accessMode: "bulk",
            countries: ["DE"],
            whole: false,
            basis: "observed",
          },
        ],
      ],
      [
        "osm-parking",
        [
          {
            stream: "static",
            accessMode: "on_demand",
            countries: ["DE"],
            whole: false,
            basis: "observed",
          },
        ],
      ],
    ]);
  });

  test("reads both answers with the operator token, once for the three domains read together", async () => {
    const { http, reader } = readerWith(answers(), {
      OPENCONDITIONS_URL: BASE_URL,
      OPENCONDITIONS_OPERATOR_TOKEN: "op-token",
    });
    await Promise.all([reader.read("charging"), reader.read("parking"), reader.read("fuel")]);

    expect(http.calls.map((call) => call.url).sort()).toEqual([
      `${BASE_URL}/coverage`,
      `${BASE_URL}/feeds/status`,
    ]);
    expect(
      http.calls.every((call) => call.options?.headers?.Authorization === "Bearer op-token"),
    ).toBe(true);

    // A later read asks again.
    await reader.read("charging");
    expect(http.calls).toHaveLength(4);
  });

  test.each([
    ["/coverage fails", answers(new Error("503"))],
    ["/feeds/status fails", answers(clone(coverageAnswer), new Error("503"))],
    ["/coverage has no rows", answers({ generatedAt: "2026-10-06T10:00:00.000Z" })],
    [
      "a /coverage row has no access mode",
      answers({
        generatedAt: "2026-10-06T10:00:00.000Z",
        coverage: [{ ...coverageAnswer.coverage[0], accessMode: undefined }],
      }),
    ],
    [
      "a /coverage row names no sources",
      answers({
        generatedAt: "2026-10-06T10:00:00.000Z",
        coverage: [{ ...coverageAnswer.coverage[0], sources: "de-bnetza-charging" }],
      }),
    ],
    ["/feeds/status lists no feeds", answers(clone(coverageAnswer), { instanceId: "oc-eu-1" })],
  ])("fails closed when %s", async (_case, respond) => {
    const { reader } = readerWith(respond);
    await expect(reader.read("charging")).rejects.toThrow();
  });

  test("fails closed before the source list arrives", async () => {
    const { http, reader } = readerWith(answers(), undefined, {
      ready: false,
      get: () => undefined,
    });
    await expect(reader.read("charging")).rejects.toThrow("source list");
    expect(http.calls).toEqual([]);
  });

  test("the place providers expose it and road evidence keeps to the road feeds", async () => {
    const { client, reader } = readerWith(answers());
    const charging = createChargingSiteProvider(client, EVERY_SOURCE, { evidence: reader });
    const parking = createParkingSiteProvider(client, EVERY_SOURCE, { evidence: reader });
    const fuel = createFuelStationProvider(client, EVERY_SOURCE, { evidence: reader });
    const road = createRoadConditionsProvider(client, EVERY_SOURCE);

    expect((await charging.getOperationalEvidence!()).feeds).toHaveLength(6);
    expect((await parking.getOperationalEvidence!()).feeds).toHaveLength(2);
    expect((await fuel.getOperationalEvidence!()).feeds).toHaveLength(3);
    const roads = await road.getOperationalEvidence!();
    expect(roads.feeds.map((feed) => feed.sourceId)).toEqual(["nl-ndw-events"]);
    expect(roads.feeds[0]?.coverage).toBeUndefined();
    // Without a reader a place provider has no operational evidence.
    expect(createChargingSiteProvider(client, EVERY_SOURCE).getOperationalEvidence).toBeUndefined();
  });

  test("the source scopes keep a valid catalogue coverage and drop an invalid one", () => {
    const scopes = createSourceScopes();
    const described = (id: string, coverage: unknown) =>
      ({ id, accessMode: "on_demand", coverage }) as unknown as OcSource;
    scopes.update([
      described("ocm-charging", {
        countries: ["de", "AT", "Germany", 4],
        bbox: [-180, -90, 180, 90],
      }),
      described("osm-charging", { countries: [], bbox: [10, 50, 10, 60] }),
      described("osm-parking", { countries: ["DE-BW", "de-by", "FR"] }),
    ]);
    // A subdivision code stands for its country.
    expect(scopes.get("osm-parking")).toEqual({ accessMode: "on_demand", countries: ["DE", "FR"] });

    expect(scopes.get("ocm-charging")).toEqual({
      accessMode: "on_demand",
      countries: ["AT", "DE"],
      bbox: [-180, -90, 180, 90],
    });
    expect(scopes.get("osm-charging")).toEqual({ accessMode: "on_demand" });
  });

  test("setup gives the three place providers one reader, scoped by the source list", async () => {
    const http = fakeHttpClient((req) =>
      req.url.endsWith("/sources")
        ? {
            scope: "operator",
            sources: [
              {
                id: "at-econtrol-fuel",
                name: "E-Control",
                domain: "fuel",
                product: "fuel",
                operator: "econtrol",
                region: "at",
                country: "at",
                accessMode: "on_demand",
                restricted: false,
                license: "CC-BY-4.0",
                attribution: "E-Control",
                homepage: "https://www.e-control.at",
                privacyUrl: "https://www.e-control.at/datenschutz",
                rights: {
                  redistribution: true,
                  derivedRedistribution: true,
                  commercialUse: true,
                  attributionRequired: true,
                  retention: true,
                  shareAlike: false,
                },
              },
            ],
          }
        : answers()(req),
    );
    const ctx = createMockIntegrationContext({ id: "openconditions", http });
    await setup(ctx, { OPENCONDITIONS_URL: BASE_URL });
    const [, , fuel] = await Promise.all([
      ctx.registered.chargingSites[0]!.getOperationalEvidence!(),
      ctx.registered.parkingSites[0]!.getOperationalEvidence!(),
      ctx.registered.fuelStations[0]!.getOperationalEvidence!(),
    ]);

    expect(http.calls.filter((call) => call.url.endsWith("/coverage"))).toHaveLength(1);
    expect(http.calls.filter((call) => call.url.endsWith("/feeds/status"))).toHaveLength(1);
    expect(byId(fuel.feeds, "at-econtrol-fuel")?.coverage).toEqual([
      {
        stream: "static",
        accessMode: "on_demand",
        countries: ["AT"],
        whole: false,
        basis: "declared",
      },
    ]);
  });
});

import type { AuthorityObservation, CoverageRegion, StreamEvidence } from "@openmapx/core/coverage";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "coverage-service-test-secret";
});

import type {
  LoadedIntegration,
  OperationalEvidence,
  OperationalFeedEvidence,
} from "@openmapx/integration-framework";
import { buildCoverageCatalog } from "./catalog.js";
import type { CoverageCollection } from "./collect.js";
import { collectCoverageData, freshenStream, runtimeForProvider } from "./collect.js";
import { createCoverageService } from "./service.js";

const REGION: CoverageRegion = {
  key: "extract:test",
  label: "Test extract",
  kind: "extract",
};

function makeStream(staleAt: string): StreamEvidence {
  return {
    key: "service:data-manager:test",
    owner: { kind: "service", id: "data-manager" },
    sourceId: "test-source",
    stream: "static",
    domain: "pois",
    observedAt: "2026-09-10T12:00:00.000Z",
    evidenceVersion: 1,
    presence: "present",
    region: { keys: [REGION.key], basis: "published-region", relation: "unknown" },
    publication: {
      version: "v1",
      publishedAt: "2026-09-10T12:00:00.000Z",
      active: true,
    },
    attempt: { at: "2026-09-10T12:00:00.000Z", outcome: "succeeded" },
    lastSuccessfulCheckAt: "2026-09-10T12:00:00.000Z",
    lastSuccessfullyCheckedVersion: "v1",
    upstreamAsOf: null,
    expiresAt: null,
    policy: {
      basis: "test",
      staleAt,
      expiresAt: null,
      version: "test-v1",
      provenance: "test fixture",
    },
    freshness: "current",
    reasons: [],
  };
}

function makeCollection(stream: StreamEvidence): CoverageCollection {
  const authorities: AuthorityObservation[] = [
    { authority: "data-manager", status: "available", observedAt: stream.observedAt },
  ];
  return {
    generatedAt: stream.observedAt,
    collectionStatus: "complete",
    authorities,
    warnings: [],
    regions: [REGION],
    streams: [stream],
    catalog: { integrations: [], providers: [], rights: [] },
    integrationHealth: { updatedAt: null, results: [] },
    providerHealth: new Map(),
    bindings: new Map(),
    policy: null,
    unassignedSourceCount: 0,
    dataManagerSnapshotId: "dm-test",
  };
}

describe("CoverageService", () => {
  const integration = (): LoadedIntegration => ({
    id: "parking",
    manifest: {
      id: "parking",
      domains: ["parking-sites"],
      dataSources: [
        {
          sourceId: "test-source",
          name: "Test",
          url: "https://example.test",
          license: "Recorded",
          providerCountry: "DE",
          providerPrivacyUrl: "https://example.test/privacy",
          commercialUse: "yes",
        },
      ],
    },
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([
      ["parking-sites", [{ id: "parking", searchSites: async () => ({ sites: [] }) }]],
    ]),
    strings: {},
    shutdownHandlers: [],
  });

  it("reads persisted road evidence without invoking event queries or polling jobs", async () => {
    const getEvents = vi.fn(async () => []);
    const getOperationalEvidence = vi.fn(async () => ({
      schemaVersion: 1 as const,
      instanceId: "oc-instance",
      collectedAt: "2026-09-11T12:00:00Z",
      feeds: [],
    }));
    const road = integration();
    road.manifest.domains = ["road-conditions"];
    road.providers = new Map([
      ["road-conditions", [{ id: "oc", getEvents, getOperationalEvidence }]],
    ]);
    const result = await collectCoverageData({
      now: () => new Date("2026-09-11T12:00:00Z"),
      integrations: [road],
      dataManager: {
        read: async () => {
          throw new Error("Unavailable");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({ updatedAt: null, results: [] }),
    });
    expect(result.collectionStatus).toBe("partial");
    expect(getOperationalEvidence).toHaveBeenCalledTimes(1);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("retains API evidence when data-manager is unavailable", async () => {
    const parking = integration();
    parking.manifest.domains = ["parking-sites"];
    const collected = await collectCoverageData({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      integrations: [parking],
      dataManager: {
        read: async () => {
          throw new Error("secret internal address");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({ updatedAt: null, results: [] }),
    });
    expect(collected.collectionStatus).toBe("partial");
    expect(collected.regions).toContainEqual(expect.objectContaining({ key: "unassigned" }));
    expect(collected.streams).toHaveLength(1);
    expect(JSON.stringify(collected)).not.toContain("secret internal address");
  });

  it("files a source under the coverage domain its own manifest domain names", async () => {
    const both = integration();
    both.id = "openconditions";
    both.manifest.id = "openconditions";
    both.manifest.domains = ["road-conditions", "fuel-stations", "parking-sites", "charging-sites"];
    both.manifest.dataSources = [
      { ...both.manifest.dataSources![0]!, sourceId: "nl-ndw-events", name: "NDW" },
      { ...both.manifest.dataSources![0]!, sourceId: "osm-fuel", domain: "fuel-stations" },
      {
        ...both.manifest.dataSources![0]!,
        sourceId: "de-bw-mobidata-parking",
        domain: "parking-sites",
      },
      {
        ...both.manifest.dataSources![0]!,
        sourceId: "de-bw-mobidata-charging",
        domain: "charging-sites",
      },
    ];
    both.providers = new Map();
    const collected = await collectCoverageData({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      integrations: [both],
      dataManager: {
        read: async () => {
          throw new Error("Unavailable");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({ updatedAt: null, results: [] }),
    });
    // A source naming no domain of its own takes the integration's: road conditions here.
    expect(collected.streams.map((s) => [s.sourceId, s.domain])).toEqual([
      ["de-bw-mobidata-charging", "ev"],
      ["de-bw-mobidata-parking", "parking"],
      ["nl-ndw-events", "traffic"],
      ["osm-fuel", "fuel"],
    ]);
  });

  it("uses the aggregate scheduled health check and expires positive evidence", () => {
    const collection = makeCollection(makeStream("2026-09-10T13:00:00.000Z"));
    collection.catalog = buildCoverageCatalog([integration()]);
    collection.integrationHealth = {
      updatedAt: Date.parse(collection.generatedAt),
      results: [
        { id: "parking:child", name: "child", category: "test", url: "", status: "up" },
        { id: "parking", name: "parking", category: "test", url: "", status: "down" },
      ],
    };
    const provider = collection.catalog.providers[0];
    if (!provider) throw new Error("Fixture provider missing");
    expect(runtimeForProvider(provider, collection, new Date(collection.generatedAt)).status).toBe(
      "down",
    );
    const aggregate = collection.integrationHealth.results[1];
    if (!aggregate) throw new Error("Fixture aggregate missing");
    aggregate.status = "up";
    expect(
      runtimeForProvider(provider, collection, new Date("2026-09-10T12:02:00.000Z")).status,
    ).toBe("unknown");
    expect(
      runtimeForProvider(provider, collection, new Date("2026-09-10T11:59:00.000Z")).status,
    ).toBe("unknown");
  });

  it("does not combine fresh data outside the region with stale local data", async () => {
    const local = {
      ...makeStream("2026-09-10T11:59:00.000Z"),
      owner: { kind: "integration" as const, id: "parking" },
      domain: "parking" as const,
      region: {
        keys: [REGION.key],
        bounds: [10, 50, 11, 51] as const,
        basis: "published-region" as const,
        relation: "unknown" as const,
      },
    };
    const remote = {
      ...local,
      key: "remote",
      policy: { ...local.policy, staleAt: "2026-09-10T13:00:00.000Z" },
      region: { ...local.region, keys: ["extract:remote"], bounds: [0, 0, 1, 1] as const },
    };
    const collection = makeCollection(local);
    collection.regions = [{ ...REGION, bounds: [10, 50, 11, 51] }];
    collection.streams = [local, remote];
    collection.catalog = buildCoverageCatalog([integration()]);
    collection.policy = { allowGreyArea: true, allowNonCommercial: true };
    collection.integrationHealth = {
      updatedAt: Date.parse(collection.generatedAt),
      results: [{ id: "parking", name: "parking", category: "test", url: "", status: "up" }],
    };
    const service = createCoverageService({
      now: () => new Date(collection.generatedAt),
      collector: async () => collection,
    });
    const report = await service.report({ regionId: REGION.key });
    const discovery = report.capabilities.find(
      (item) => item.operationId === "parking.facility-discovery",
    );
    expect(discovery).toMatchObject({ status: "limited", evidenceKeys: [local.key] });
    expect(report.summary.find((item) => item.domain === "parking")?.status).not.toBe(
      "operational",
    );
  });

  it("requires pinned continuation pages and permits attention views on a matrix revision", async () => {
    const service = createCoverageService({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      collector: async () => makeCollection(makeStream("2026-09-10T13:00:00.000Z")),
    });
    await expect(service.report({ regionId: REGION.key, offset: 1 })).rejects.toMatchObject({
      code: "snapshot_required",
    });
    const matrix = await service.regions();
    await expect(
      service.report({ regionId: REGION.key, attention: true, snapshotId: matrix.snapshotId }),
    ).resolves.toMatchObject({ snapshotId: matrix.snapshotId });
  });
  it("retains evidence reasons when freshness is recomputed", () => {
    const stream = makeStream("2026-09-10T13:00:00.000Z");
    stream.reasons = ["source_partial"];
    expect(freshenStream(stream, new Date("2026-09-10T12:00:00.000Z")).reasons).toContain(
      "source_partial",
    );
  });

  it("returns the next freshness deadline and rechecks attention membership", async () => {
    let now = new Date("2026-09-10T12:00:00.000Z");
    const service = createCoverageService({
      now: () => now,
      collector: async () => makeCollection(makeStream("2026-09-10T13:00:00.000Z")),
    });

    const report = await service.report({ regionId: REGION.key });
    expect(report.nextDeadlineAt).toBe("2026-09-10T13:00:00.000Z");
    expect(report.sources[0]?.freshnessDeadline).toBe("2026-09-10T13:00:00.000Z");

    const attention = await service.report({ regionId: REGION.key, attention: true });
    expect(attention.sources).toEqual([]);
    now = new Date("2026-09-10T13:00:00.000Z");
    await expect(
      service.report({
        regionId: REGION.key,
        attention: true,
        snapshotId: attention.snapshotId,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "snapshot_expired",
    });
  });

  it("reports ev from the charging-sites provider and keeps route planning reachable with a router", async () => {
    const charging = integration();
    charging.id = "openconditions";
    charging.manifest.id = "openconditions";
    charging.manifest.domains = ["charging-sites"];
    charging.manifest.dataSources = [
      {
        ...charging.manifest.dataSources![0]!,
        sourceId: "de-bw-mobidata-charging",
        domain: "charging-sites",
      },
    ];
    charging.providers = new Map([
      [
        "charging-sites",
        [{ id: "charging-sites-openconditions", searchSites: async () => ({ sites: [] }) }],
      ],
    ]);
    const router = integration();
    router.id = "routing-valhalla";
    router.manifest.id = "routing-valhalla";
    router.manifest.domains = ["routing"];
    router.manifest.dataSources = [];
    router.providers = new Map([["routing", [{ id: "valhalla", supportedModes: ["driving"] }]]]);

    const catalog = buildCoverageCatalog([charging, router]);
    const chargers = catalog.providers.filter((p) => p.integrationId === "openconditions");
    expect(chargers.map((p) => [p.providerId, p.supports])).toEqual([
      [
        "charging-sites-openconditions",
        {
          "ev.charger-discovery": true,
          "ev.charger-availability": true,
          "ev.route-planning": true,
        },
      ],
    ]);

    const stream = {
      ...makeStream("2026-09-10T13:00:00.000Z"),
      key: "service:openconditions:de-bw-mobidata-charging",
      owner: { kind: "integration" as const, id: "openconditions" },
      sourceId: "de-bw-mobidata-charging",
      domain: "ev" as const,
    };
    const collection = makeCollection(stream);
    collection.catalog = catalog;
    collection.policy = { allowGreyArea: true, allowNonCommercial: true };
    const service = createCoverageService({
      now: () => new Date(collection.generatedAt),
      collector: async () => collection,
    });

    const report = await service.report({ regionId: REGION.key });
    const byId = (id: string) => report.capabilities.find((item) => item.operationId === id);
    expect(byId("ev.charger-discovery")?.evidenceKeys).toEqual([stream.key]);
    const route = byId("ev.route-planning");
    expect(route?.status).not.toBe("unsupported");
    expect(route?.candidates?.[0]).toMatchObject({
      providerId: "valhalla+charging-sites-openconditions",
      operationSupported: true,
    });
    expect(route?.evidenceKeys).toContain(stream.key);
  });

  it("cites only streams of the operation's own domain for an integration serving several", async () => {
    const mixed = integration();
    mixed.id = "openconditions";
    mixed.manifest.id = "openconditions";
    mixed.manifest.domains = ["charging-sites", "parking-sites", "road-conditions"];
    const template = mixed.manifest.dataSources![0]!;
    mixed.manifest.dataSources = [
      { ...template, sourceId: "z-charging", domain: "charging-sites" },
      { ...template, sourceId: "a-parking", domain: "parking-sites" },
      { ...template, sourceId: "a-road", domain: "road-conditions" },
    ];
    mixed.providers = new Map([
      [
        "charging-sites",
        [{ id: "charging-sites-openconditions", searchSites: async () => ({ sites: [] }) }],
      ],
    ]);
    const parking = integration();
    parking.manifest.dataSources = [
      { ...template, sourceId: "a-parking" },
      { ...template, sourceId: "z-parking" },
    ];

    const stream = (
      sourceId: string,
      domain: "ev" | "parking" | "traffic",
      owner: string,
      kind: "static" | "live" = "static",
    ) => ({
      ...makeStream("2026-09-10T13:00:00.000Z"),
      key: `${owner}:${sourceId}:${kind}`,
      owner: { kind: "integration" as const, id: owner },
      sourceId,
      stream: kind,
      domain,
    });
    // The other domains' sources sort first, so a stream picked by name alone would be theirs.
    const evStatic = stream("z-charging", "ev", "openconditions");
    const evLive = stream("z-charging", "ev", "openconditions", "live");
    const roadStatic = stream("a-road", "traffic", "openconditions");
    const roadLive = stream("a-road", "traffic", "openconditions", "live");
    const parkingStatic = stream("a-parking", "parking", "openconditions");
    const ownParking = stream("z-parking", "parking", "parking");
    const ownParkingEv = stream("a-parking", "ev", "parking");
    const collection = makeCollection(evStatic);
    collection.streams = [
      evStatic,
      evLive,
      roadStatic,
      roadLive,
      parkingStatic,
      ownParking,
      ownParkingEv,
    ];
    collection.catalog = buildCoverageCatalog([mixed, parking]);
    collection.policy = { allowGreyArea: true, allowNonCommercial: true };
    const service = createCoverageService({
      now: () => new Date(collection.generatedAt),
      collector: async () => collection,
    });

    const report = await service.report({ regionId: REGION.key });
    const byId = (id: string) => report.capabilities.find((item) => item.operationId === id);
    expect(byId("ev.charger-discovery")?.evidenceKeys).toEqual([evStatic.key]);
    expect(byId("ev.charger-availability")?.evidenceKeys).toEqual([evLive.key]);
    expect(byId("parking.facility-discovery")?.evidenceKeys).toEqual([ownParking.key]);
  });

  it("keeps globally scoped evidence in the unassigned region", async () => {
    const regional = makeStream("2026-09-10T13:00:00.000Z");
    const unassigned = {
      ...makeStream("2026-09-10T13:00:00.000Z"),
      key: "service:data-manager:global",
      sourceId: "global-source",
      region: { keys: [], basis: "unknown" as const, relation: "unknown" as const },
    };
    const collection = {
      ...makeCollection(regional),
      streams: [regional, unassigned],
      unassignedSourceCount: 1,
      regions: [
        REGION,
        { key: "unassigned", label: "Region not specified", kind: "unassigned" as const },
      ],
    };
    const service = createCoverageService({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      collector: async () => collection,
    });

    const report = await service.report({ regionId: REGION.key });
    expect(report.sources.map((source) => source.key)).toEqual([regional.key]);

    const regions = await service.regions();
    expect(regions.regions.find((entry) => entry.region.key === REGION.key)?.sourceCount).toBe(1);
    expect(regions.regions.find((entry) => entry.region.key === "unassigned")?.sourceCount).toBe(1);
  });
});

describe("coverage of the OpenConditions place domains", () => {
  const NOW = new Date("2026-10-06T10:00:00.000Z");

  type Coverage = NonNullable<OperationalFeedEvidence["coverage"]>;
  type Entry = Coverage[number];
  const entry = (
    stream: Entry["stream"],
    accessMode: Entry["accessMode"],
    countries: string[],
    whole: boolean,
    basis: Entry["basis"] = "observed",
  ): Entry => ({ stream, accessMode, countries, whole, basis });
  /** A bulk feed with places and readings, holding `countries` whole. */
  const bulk = (...countries: string[]): Coverage => [
    entry("static", "bulk", countries, true),
    entry("live", "bulk", countries, true),
  ];
  /** A bulk feed of one subdivision of `country`. */
  const subdivision = (country: string): Coverage => [
    entry("static", "bulk", [country], false),
    entry("live", "bulk", [country], false),
  ];
  const onDemand = (...countries: string[]): Coverage => [
    entry("static", "on_demand", countries, false),
  ];

  const feed = (
    sourceId: string,
    coverage: Coverage,
    over: Partial<OperationalFeedEvidence> = {},
  ): OperationalFeedEvidence => ({
    sourceId,
    lastAttemptAt: "2026-10-06T09:55:00.000Z",
    lastOutcome: "changed",
    lastSuccessfulCheckAt: "2026-10-06T09:55:00.000Z",
    lastPublicationAt: "2026-10-06T09:55:00.000Z",
    publicationRevision: "12",
    upstreamAsOf: null,
    freshUntil: "2026-10-06T10:25:00.000Z",
    expectedIntervalSeconds: 300,
    activeEventCount: 100,
    changedCount: 0,
    rejectedCount: 0,
    consecutiveFailures: 0,
    error: null,
    bindingCounts: null,
    graph: { generation: null, status: "unknown", regions: [] },
    coverage,
    status: "healthy",
    action: null,
    ...over,
  });

  const evidence = (...feeds: OperationalFeedEvidence[]): OperationalEvidence => ({
    schemaVersion: 1,
    instanceId: "oc-eu-1",
    collectedAt: NOW.toISOString(),
    feeds,
  });

  const CHARGING = evidence(
    feed("de-bnetza-charging", [entry("static", "bulk", ["DE"], true)]),
    feed("de-bw-mobidata-charging", subdivision("DE")),
    feed("nl-ndw-charging", bulk("NL")),
    feed("ocm-charging", onDemand("DE", "FR", "US")),
    feed("us-afdc-charging", [entry("static", "bulk", ["US"], true)]),
  );
  const PARKING = evidence(
    feed("de-bw-mobidata-parking", subdivision("DE")),
    feed("nl-ndw-parking", bulk("NL")),
  );
  const FUEL = evidence(
    // On demand and never asked for yet: no record, no poll, only its catalogue country.
    feed("at-econtrol-fuel", [entry("static", "on_demand", ["AT"], false, "declared")], {
      lastAttemptAt: null,
      lastOutcome: null,
      lastSuccessfulCheckAt: null,
      lastPublicationAt: null,
      publicationRevision: null,
      freshUntil: null,
      activeEventCount: null,
      status: "unknown",
    }),
    feed("de-tankerkoenig-fuel", [...onDemand("DE"), entry("live", "on_demand", ["DE"], false)]),
    feed("fr-prixcarburants-fuel", bulk("FR")),
  );

  const CAMERAS = evidence(
    feed("fi-digitraffic-cameras", bulk("FI")),
    feed("windy-cameras", [entry("static", "on_demand", ["DE"], false)]),
  );

  const source = (sourceId: string, domain: string) => ({
    sourceId,
    domain,
    name: sourceId,
    url: `https://${sourceId}.example`,
    license: "CC-BY-4.0",
    providerCountry: "DE",
    providerPrivacyUrl: "https://example.test/privacy",
    commercialUse: "yes" as const,
  });

  function openconditions(
    read: Partial<
      Record<"charging" | "parking" | "fuel" | "cameras", () => Promise<OperationalEvidence>>
    > = {},
    withCameras = false,
  ): LoadedIntegration {
    return {
      id: "openconditions",
      manifest: {
        id: "openconditions",
        domains: ["charging-sites", "parking-sites", "fuel-stations"],
        dataSources: [
          ...CHARGING.feeds.map((f) => source(f.sourceId, "charging-sites")),
          ...PARKING.feeds.map((f) => source(f.sourceId, "parking-sites")),
          ...FUEL.feeds.map((f) => source(f.sourceId, "fuel-stations")),
          ...(withCameras ? CAMERAS.feeds.map((f) => source(f.sourceId, "cameras")) : []),
        ],
      },
      config: {},
      directory: "/fixture",
      isBuiltIn: true,
      enabled: true,
      providers: new Map<string, unknown[]>([
        [
          "charging-sites",
          [
            {
              id: "charging-sites-openconditions",
              searchSites: async () => ({ sites: [] }),
              getOperationalEvidence: read.charging ?? (async () => CHARGING),
            },
          ],
        ],
        [
          "parking-sites",
          [
            {
              id: "parking-sites-openconditions",
              searchSites: async () => ({ sites: [] }),
              getOperationalEvidence: read.parking ?? (async () => PARKING),
            },
          ],
        ],
        [
          "fuel-stations",
          [
            {
              id: "fuel-stations-openconditions",
              searchStations: async () => ({ stations: [] }),
              getOperationalEvidence: read.fuel ?? (async () => FUEL),
            },
          ],
        ],
        ...(withCameras
          ? [
              [
                "cameras",
                [
                  {
                    id: "cameras-openconditions",
                    searchCameras: async () => ({ cameras: [] }),
                    getCamera: async () => null,
                    getOperationalEvidence: read.cameras ?? (async () => CAMERAS),
                  },
                ],
              ] as [string, unknown[]],
            ]
          : []),
      ]),
      strings: {},
      shutdownHandlers: [],
    };
  }

  const router = (): LoadedIntegration => ({
    id: "routing-valhalla",
    manifest: { id: "routing-valhalla", domains: ["routing"], dataSources: [] },
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["routing", [{ id: "valhalla", supportedModes: ["driving"] }]]]),
    strings: {},
    shutdownHandlers: [],
  });

  const collect = (integrations: LoadedIntegration[]) =>
    collectCoverageData({
      now: () => NOW,
      integrations,
      dataManager: {
        read: async () => {
          throw new Error("Unavailable");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({
        updatedAt: NOW.getTime(),
        results: integrations.map((i) => ({
          id: i.id,
          name: i.id,
          category: "test",
          url: "",
          status: "up" as const,
        })),
      }),
    });

  it("collects static and live streams from each place provider and names their countries", async () => {
    const collected = await collect([openconditions()]);
    const site = collected.streams.filter((s) => s.stream !== "catalog");

    expect(site.map((s) => [s.domain, s.sourceId, s.stream, s.reasons])).toEqual([
      ["ev", "de-bnetza-charging", "static", []],
      ["ev", "de-bw-mobidata-charging", "live", ["source_partial"]],
      ["ev", "de-bw-mobidata-charging", "static", ["source_partial"]],
      ["ev", "nl-ndw-charging", "live", []],
      ["ev", "nl-ndw-charging", "static", []],
      ["ev", "ocm-charging", "static", ["source_partial"]],
      ["ev", "us-afdc-charging", "static", []],
      ["fuel", "at-econtrol-fuel", "static", ["source_partial"]],
      ["fuel", "de-tankerkoenig-fuel", "live", ["source_partial"]],
      ["fuel", "de-tankerkoenig-fuel", "static", ["source_partial"]],
      ["fuel", "fr-prixcarburants-fuel", "live", []],
      ["fuel", "fr-prixcarburants-fuel", "static", []],
      ["parking", "de-bw-mobidata-parking", "live", ["source_partial"]],
      ["parking", "de-bw-mobidata-parking", "static", ["source_partial"]],
      ["parking", "nl-ndw-parking", "live", []],
      ["parking", "nl-ndw-parking", "static", []],
    ]);
    expect(site.every((s) => s.owner.id === "openconditions" && s.presence === "present")).toBe(
      true,
    );
    // A source with evidence is not repeated as a bare declaration.
    expect(collected.streams.filter((s) => s.stream === "catalog")).toEqual([]);
    expect(collected.regions.map((r) => [r.key, r.kind, r.label])).toEqual(
      expect.arrayContaining([
        ["country:AT", "country", "Austria"],
        ["country:DE", "country", "Germany"],
        ["country:FR", "country", "France"],
        ["country:NL", "country", "Netherlands"],
        ["country:US", "country", "United States"],
      ]),
    );
  });

  it("keeps road evidence when a place provider's read hangs", { timeout: 10_000 }, async () => {
    const road: LoadedIntegration = {
      ...router(),
      id: "road-conditions-fixture",
      manifest: {
        id: "road-conditions-fixture",
        domains: ["road-conditions"],
        dataSources: [source("nl-ndw-events", "road-conditions")],
      },
      providers: new Map([
        [
          "road-conditions",
          [
            {
              id: "road",
              getEvents: async () => [],
              getOperationalEvidence: async () =>
                evidence(
                  feed("nl-ndw-events", [], {
                    graph: { generation: "g", status: "ready", regions: ["nl"] },
                  }),
                ),
            },
          ],
        ],
      ]),
    };
    const collected = await collect([
      road,
      openconditions({ charging: () => new Promise<OperationalEvidence>(() => {}) }),
    ]);

    expect(collected.warnings).toContain("collector_unavailable");
    const live = collected.streams.filter((s) => s.stream !== "catalog");
    expect(live.filter((s) => s.domain === "traffic").map((s) => s.sourceId)).toEqual([
      "nl-ndw-events",
    ]);
    expect(live.some((s) => s.domain === "ev")).toBe(false);
    expect(live.some((s) => s.domain === "parking")).toBe(true);
  });

  it("keeps the other domains when one provider's evidence fails", async () => {
    const collected = await collect([
      openconditions({
        parking: async () => {
          throw new Error("OpenConditions /coverage responded 503");
        },
      }),
    ]);

    expect(collected.collectionStatus).toBe("partial");
    expect(collected.warnings).toContain("collector_unavailable");
    const domains = new Set(
      collected.streams.filter((s) => s.stream !== "catalog").map((s) => s.domain),
    );
    expect([...domains].sort()).toEqual(["ev", "fuel"]);
    // The parking sources fall back to their declarations.
    expect(collected.streams.filter((s) => s.domain === "parking").map((s) => s.stream)).toEqual([
      "catalog",
      "catalog",
    ]);
  });

  async function reportFor(regionId: string) {
    const collection = await collect([openconditions(), router()]);
    const service = createCoverageService({ now: () => NOW, collector: async () => collection });
    const report = await service.report({ regionId });
    return (id: string) => report.capabilities.find((item) => item.operationId === id);
  }

  it("is operational where fresh bulk feeds hold the country whole", async () => {
    const de = await reportFor("country:DE");
    expect(de("ev.charger-discovery")).toMatchObject({
      status: "operational",
      evidenceKeys: ["ev:openconditions:oc-eu-1:de-bnetza-charging:static"],
    });

    const nl = await reportFor("country:NL");
    expect(nl("ev.charger-availability")).toMatchObject({
      status: "operational",
      evidenceKeys: ["ev:openconditions:oc-eu-1:nl-ndw-charging:live"],
    });
    expect(nl("parking.facility-discovery")?.status).toBe("operational");
    expect(nl("parking.occupancy")?.status).toBe("operational");

    const fr = await reportFor("country:FR");
    expect(fr("fuel.station-discovery")?.status).toBe("operational");
    expect(fr("fuel.prices")?.status).toBe("operational");
  });

  it("prefers a bulk feed over an on-demand one in the same country", async () => {
    // ocm-charging sorts before us-afdc-charging, so a pick by name alone would be partial.
    const us = await reportFor("country:US");

    expect(us("ev.charger-discovery")).toMatchObject({
      status: "operational",
      evidenceKeys: ["ev:openconditions:oc-eu-1:us-afdc-charging:static"],
    });
  });

  it("reports a country one subdivision's bulk feed holds as partial", async () => {
    // de-bw-mobidata-parking is the only parking feed in Germany: Baden-Württemberg is not Germany.
    const de = await reportFor("country:DE");
    for (const id of ["parking.facility-discovery", "parking.occupancy"]) {
      expect(de(id)?.status).toBe("limited");
      expect(de(id)?.reasons).toContain("source_partial");
    }
    expect(de("ev.charger-availability")?.status).toBe("limited");
  });

  it("reports an area only on-demand feeds reach as partial", async () => {
    const de = await reportFor("country:DE");
    expect(de("fuel.station-discovery")).toMatchObject({ status: "limited" });
    expect(de("fuel.station-discovery")?.reasons).toContain("source_partial");
    expect(de("fuel.prices")?.status).toBe("limited");

    const fr = await reportFor("country:FR");
    expect(fr("ev.charger-discovery")?.status).toBe("limited");
    expect(fr("ev.charger-discovery")?.reasons).toContain("source_partial");
  });

  it("reports camera discovery and images from the camera provider's feeds", async () => {
    const collection = await collect([openconditions({}, true), router()]);
    const cameraStreams = collection.streams.filter(
      (s) => s.domain === "cameras" && s.stream !== "catalog",
    );
    expect(cameraStreams.map((s) => [s.sourceId, s.stream, s.reasons])).toEqual([
      ["fi-digitraffic-cameras", "live", []],
      ["fi-digitraffic-cameras", "static", []],
      ["windy-cameras", "static", ["source_partial"]],
    ]);
    const service = createCoverageService({ now: () => NOW, collector: async () => collection });
    const report = async (regionId: string) => {
      const r = await service.report({ regionId });
      return (id: string) => r.capabilities.find((item) => item.operationId === id);
    };

    const fi = await report("country:FI");
    expect(fi("cameras.discovery")).toMatchObject({
      status: "operational",
      evidenceKeys: ["cameras:openconditions:oc-eu-1:fi-digitraffic-cameras:static"],
    });
    expect(fi("cameras.images")).toMatchObject({
      status: "operational",
      evidenceKeys: ["cameras:openconditions:oc-eu-1:fi-digitraffic-cameras:live"],
    });

    // Windy and OSM answer only for the area asked, so they never hold a country whole.
    const de = await report("country:DE");
    expect(de("cameras.discovery")?.status).toBe("limited");
    expect(de("cameras.discovery")?.reasons).toContain("source_partial");
    expect(de("cameras.images")?.status).not.toBe("operational");
  });

  it("reports an on-demand feed's country as partial before any read fetched there", async () => {
    const at = await reportFor("country:AT");
    expect(at("fuel.station-discovery")).toMatchObject({
      status: "limited",
      evidenceKeys: ["fuel:openconditions:oc-eu-1:at-econtrol-fuel:static"],
    });
    expect(at("fuel.station-discovery")?.reasons).toContain("source_partial");
  });

  it("stands a global on-demand feed for the area its catalogue declares", async () => {
    const world: [number, number, number, number] = [-180, -90, 180, 90];
    const global = evidence(
      ...CHARGING.feeds.filter((f) => f.sourceId !== "ocm-charging"),
      feed("ocm-charging", [
        {
          stream: "static",
          accessMode: "on_demand",
          countries: [],
          whole: false,
          basis: "declared",
          bbox: world,
        },
      ]),
    );
    const collection = await collect([openconditions({ charging: async () => global })]);
    const ocm = collection.streams.find((s) => s.sourceId === "ocm-charging");

    expect(ocm?.region).toMatchObject({ keys: [], basis: "declared", bounds: world });
    expect(ocm?.publication.active).toBe(true);
    const service = createCoverageService({ now: () => NOW, collector: async () => collection });
    // Not only in the unassigned bucket: every region lists it.
    const nl = await service.report({ regionId: "country:NL" });
    expect(nl.sources.some((source) => source.sourceId === "ocm-charging")).toBe(true);
    // Its box places it, so it is not also counted as naming no region.
    expect(collection.unassignedSourceCount).toBe(0);
    expect(collection.regions.some((r) => r.key === "unassigned")).toBe(false);
  });

  it("keeps a feed that names no place in the unassigned bucket beside a global one", async () => {
    const world: [number, number, number, number] = [-180, -90, 180, 90];
    const global = evidence(
      ...CHARGING.feeds.filter((f) => f.sourceId !== "ocm-charging"),
      feed("ocm-charging", [
        {
          stream: "static",
          accessMode: "on_demand",
          countries: [],
          whole: false,
          basis: "declared",
          bbox: world,
        },
      ]),
      feed("xx-nowhere-charging", []),
    );
    const collection = await collect([openconditions({ charging: async () => global })]);
    const service = createCoverageService({ now: () => NOW, collector: async () => collection });
    const unassigned = await service.report({ regionId: "unassigned" });

    expect(unassigned.sources.map((source) => source.sourceId)).toEqual(["xx-nowhere-charging"]);
    expect(collection.unassignedSourceCount).toBe(1);
  });

  it("judges EV route planning only from feeds the charging provider serves", async () => {
    // OpenConditions reports a feed the deployment does not serve (withheld in public scope).
    const withheld = evidence(
      ...CHARGING.feeds,
      feed("lu-withheld-charging", [entry("static", "bulk", ["LU"], true)]),
    );
    const collection = await collect([
      openconditions({ charging: async () => withheld }),
      router(),
    ]);
    const service = createCoverageService({ now: () => NOW, collector: async () => collection });
    const report = await service.report({ regionId: "country:LU" });
    const byId = (id: string) => report.capabilities.find((item) => item.operationId === id);

    expect(byId("ev.charger-discovery")?.evidenceKeys ?? []).not.toContain(
      "ev:openconditions:oc-eu-1:lu-withheld-charging:static",
    );
    expect(byId("ev.route-planning")?.evidenceKeys ?? []).not.toContain(
      "ev:openconditions:oc-eu-1:lu-withheld-charging:static",
    );
  });

  it("pairs the router with the charging feeds for EV route planning", async () => {
    const de = await reportFor("country:DE");
    const route = de("ev.route-planning");

    expect(route?.candidates?.[0]).toMatchObject({
      providerId: "valhalla+charging-sites-openconditions",
      operationSupported: true,
      runtime: "up",
    });
    expect(route?.evidenceKeys).toContain("ev:openconditions:oc-eu-1:de-bnetza-charging:static");
    // The charging side holds nothing back. The router publishes no evidence of
    // its base graph, so the pair stops at unknown on that alone.
    expect({ status: route?.status, reasons: route?.reasons }).toEqual({
      status: "unknown",
      reasons: ["no_publication_evidence"],
    });
  });
});

import { describe, expect, it, vi } from "vitest";

// Stub out integration-host so importing ../street-level-imagery doesn't transitively
// pull in auth.ts (which requires BETTER_AUTH_SECRET). These cases exercise
// only the pure ordering helper.
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: vi.fn(() => []),
  getIntegrationProviders: vi.fn(() => []),
}));

import { orderProviders } from "../street-level-imagery";

const CAPS = [
  { id: "mapillary", name: "Mapillary" },
  { id: "panoramax", name: "Panoramax" },
];

describe("orderProviders", () => {
  it("orders by the configured chain", () => {
    expect(orderProviders(CAPS, "panoramax,mapillary").map((c) => c.id)).toEqual([
      "panoramax",
      "mapillary",
    ]);
  });

  it("excludes providers absent from the chain", () => {
    expect(orderProviders(CAPS, "panoramax").map((c) => c.id)).toEqual(["panoramax"]);
  });

  it("ignores unknown ids in the chain", () => {
    expect(orderProviders(CAPS, "panoramax,nope").map((c) => c.id)).toEqual(["panoramax"]);
  });

  it("tolerates whitespace and empty entries", () => {
    expect(orderProviders(CAPS, " panoramax , , mapillary ").map((c) => c.id)).toEqual([
      "panoramax",
      "mapillary",
    ]);
  });

  it("returns every registered provider when no chain is configured", () => {
    // The opt-in gate is the integration's own `enabled` flag, not this list —
    // a hardcoded default here would silently drop a just-enabled provider.
    expect(orderProviders(CAPS, "").map((c) => c.id)).toEqual(["mapillary", "panoramax"]);
  });

  it("returns every registered provider when the chain is only separators", () => {
    expect(orderProviders(CAPS, " , , ").map((c) => c.id)).toEqual(["mapillary", "panoramax"]);
  });

  it("returns nothing when no provider registered", () => {
    expect(orderProviders([], "panoramax")).toEqual([]);
  });
});

import type { StreetLevelCapabilities } from "@openmapx/core";
import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { captureCoverageContributors } from "../street-level-imagery";

const source = (id: string): IntegrationDataSource => ({
  sourceId: id,
  name: id,
  url: `https://${id}.test`,
  license: "CC0",
  providerCountry: "DE",
  providerPrivacyUrl: `https://${id}.test/privacy`,
  attribution: `Required ${id} notice`,
});
const coverageCaps: StreetLevelCapabilities = {
  id: "provider",
  name: "Provider",
  color: "#000",
  endUserExposure: "server-only",
  allowsNavigationUse: true,
  search: { heading: false, capturedAfter: false, lookingAt: false },
  coverage: {
    kind: "mvt",
    minzoom: 0,
    maxzoom: 14,
    tileUrlTemplate: "/tiles/{z}/{x}/{y}",
    layers: { sequences: "lines", pictures: "dots" },
    props: { id: "id" },
    layerSourceIds: { lines: ["a"], dots: ["b"] },
  },
};
describe("coverage capabilities acquisition", () => {
  it("captures exact source-layer metadata without nearest-provider or whole-manifest guessing", () => {
    const sources = [source("a"), source("b"), source("provider-supplement")];
    const captured = captureCoverageContributors(coverageCaps, sources);
    expect(
      captured.coverage.kind === "mvt" &&
        captured.coverage.layerContributors?.lines?.map((c) => c.sourceId),
    ).toEqual(["a"]);
    expect(
      captured.coverage.kind === "mvt" &&
        captured.coverage.layerContributors?.dots?.map((c) => c.sourceId),
    ).toEqual(["b"]);
    const first = sources[0];
    if (!first) throw new Error("Missing fixture source");
    first.attribution = "Changed registry notice";
    expect(
      captured.coverage.kind === "mvt" &&
        captured.coverage.layerContributors?.lines?.[0]?.attributionText,
    ).toBe("Required a notice");
  });
  it("keeps authoritative [] for a layer despite declared IDs", () => {
    const captured = captureCoverageContributors(
      {
        ...coverageCaps,
        coverage: {
          ...(coverageCaps.coverage as Extract<
            StreetLevelCapabilities["coverage"],
            { kind: "mvt" }
          >),
          layerContributors: { lines: [] },
        },
      },
      [source("a"), source("b")],
    );
    expect(captured.coverage.kind === "mvt" && captured.coverage.layerContributors?.lines).toEqual(
      [],
    );
  });
  it("leaves unknown layer identities uncredited", () => {
    const { layerSourceIds: _, ...coverage } = coverageCaps.coverage as Extract<
      StreetLevelCapabilities["coverage"],
      { kind: "mvt" }
    >;
    const captured = captureCoverageContributors({ ...coverageCaps, coverage }, [
      source("provider"),
      source("provider-nearest-prefix"),
    ]);
    expect(captured.coverage.kind === "mvt" && captured.coverage.layerContributors).toEqual({
      lines: [],
      dots: [],
    });
  });
});

import Fastify from "fastify";
import { getAllIntegrations, getIntegrationProviders } from "../../integration-host.js";
import { streetLevelRoute } from "../street-level-imagery";

it("serves captured per-layer credits through Fastify's actual providers response", async () => {
  vi.mocked(getAllIntegrations).mockReturnValue([
    { id: "fixture", manifest: { dataSources: [source("a"), source("b")] } },
  ] as never);
  vi.mocked(getIntegrationProviders).mockReturnValue([
    { capabilities: () => coverageCaps },
  ] as never);
  const app = Fastify();
  await app.register(streetLevelRoute, { prefix: "/api" });
  const response = await app.inject({ method: "GET", url: "/api/street-level-imagery/providers" });
  expect(response.statusCode).toBe(200);
  expect(response.json()[0].coverage.layerContributors.lines[0].attributionText).toBe(
    "Required a notice",
  );
  expect(response.json()[0].coverage.layerContributors.dots[0].sourceId).toBe("b");
  await app.close();
});

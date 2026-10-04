import type { LoadedIntegrationMeta } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  generateAttributionSectionsFromManifests,
  generatePrivacySectionsFromManifests,
} from "./generateLegalSections";

const source = (sourceId: string, name: string, domain?: string) => ({
  sourceId,
  name,
  url: "https://example.test",
  license: "CC0-1.0",
  providerCountry: "NL",
  providerPrivacyUrl: "https://example.test/privacy",
  ...(domain ? { domain } : {}),
});

/** One integration in two domains: a road feed in its first domain, a fuel feed naming its own. */
const openconditions: LoadedIntegrationMeta = {
  id: "openconditions",
  name: "OpenConditions",
  enabled: true,
  domains: ["road-conditions", "fuel-stations"],
  dataSources: [
    source("nl-ndw-events", "NDW"),
    source("osm-fuel", "OpenStreetMap", "fuel-stations"),
  ],
};

describe("legal sections of a runtime source", () => {
  const runtime: LoadedIntegrationMeta = {
    ...openconditions,
    dataSources: [
      source("nl-ndw-events", "NDW", "road-conditions"),
      source("osm-fuel", "OpenStreetMap", "fuel-stations"),
      source("de-autobahn-events", "Autobahn", "road-conditions"),
    ],
    strings: {
      en: {
        dataSources: {
          "domain:road-conditions": { purpose: "Road events", dataSent: "Map area" },
          "domain:fuel-stations": { purpose: "Fuel prices", dataSent: "Search area" },
          "de-autobahn-events": { purpose: "Autobahn events", dataSent: "Nothing" },
        },
      },
    },
  };

  it("legal sections take purpose and data sent from the domain strings of a runtime source", () => {
    const rows = generatePrivacySectionsFromManifests([runtime], "en").flatMap((s) => s.rows);
    expect(rows.map((r) => [r.service, r.purpose, r.dataSent])).toEqual([
      ["NDW", "Road events", "Map area"],
      ["Autobahn", "Autobahn events", "Nothing"],
      ["OpenStreetMap", "Fuel prices", "Search area"],
    ]);
  });

  it("falls back to the integration's first domain when a source names none", () => {
    const rows = generatePrivacySectionsFromManifests(
      [{ ...runtime, dataSources: [source("nl-ndw-events", "NDW")] }],
      "en",
    ).flatMap((s) => s.rows);
    expect(rows.map((r) => r.purpose)).toEqual(["Road events"]);
  });
});

describe("legal sections of a source that names its domain", () => {
  it("lists the source under its own domain's privacy section", () => {
    const sections = generatePrivacySectionsFromManifests([openconditions], "en");
    expect(sections.map((s) => [s.labelEn, s.rows.map((r) => r.service)])).toEqual([
      ["Road Conditions", ["NDW"]],
      ["Fuel Stations", ["OpenStreetMap"]],
    ]);
  });

  it("lists the source under its own domain's attribution section", () => {
    const sections = generateAttributionSectionsFromManifests([openconditions], "de");
    expect(sections.map((s) => [s.headingDe, s.rows.map((r) => r.source)])).toEqual([
      ["Straßenlage", ["NDW"]],
      ["Tankstellen", ["OpenStreetMap"]],
    ]);
  });
});

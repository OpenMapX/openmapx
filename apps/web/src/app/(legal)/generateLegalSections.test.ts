import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { describe, expect, it } from "vitest";
import iocManifest from "../../../../../integrations/knowledge-tides-ioc/manifest.json";
import iocDe from "../../../../../integrations/knowledge-tides-ioc/strings/de.json";
import iocEn from "../../../../../integrations/knowledge-tides-ioc/strings/en.json";
import nauticalManifest from "../../../../../integrations/overlay-nautical/manifest.json";
import nauticalDe from "../../../../../integrations/overlay-nautical/strings/de.json";
import nauticalEn from "../../../../../integrations/overlay-nautical/strings/en.json";
import {
  generateAttributionSectionsFromManifests,
  generatePrivacySectionsFromManifests,
} from "./generateLegalSections";

const source = (sourceId: string, name: string, domain?: string) => ({
  sourceId,
  name,
  url: "https://example.test",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
    ],
  } as const,
  providerCountry: "NL",
  providerPrivacyUrl: "https://example.test/privacy",
  ...(domain ? { domain } : {}),
});

/** One integration in two domains: a road feed in its first domain, a fuel feed naming its own. */
const openconditions: IntegrationMetadata = {
  id: "openconditions",
  name: "OpenConditions",
  enabled: true,
  isBuiltIn: true,
  domains: ["road-conditions", "fuel-stations"],
  dataSources: [
    source("nl-ndw-events", "NDW"),
    source("osm-fuel", "OpenStreetMap", "fuel-stations"),
  ],
};

describe("legal sections of a runtime source", () => {
  const runtime: IntegrationMetadata = {
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

describe("IOC source terms in the generated legal disclosures", () => {
  const integrations = [
    { ...iocManifest, strings: { en: iocEn, de: iocDe } },
    { ...nauticalManifest, strings: { en: nauticalEn, de: nauticalDe } },
  ].map(
    (manifest) =>
      ({ ...manifest, name: manifest.id, enabled: true, isBuiltIn: true }) as IntegrationMetadata,
  );

  it.each(integrations)(
    "$id discloses conditional commercial permission with the originator scope",
    (integration) => {
      const row = generateAttributionSectionsFromManifests([integration], "en")
        .flatMap((section) => section.rows)
        .find((entry) => entry.url === "https://www.ioc-sealevelmonitoring.org/");
      expect(row?.commercialUse).toBe("conditional");
      expect(row?.notes).toMatch(/non-commercial/i);
      expect(row?.notes).toMatch(/commercial.*permission.*originator/i);
      expect(row?.notes).toMatch(/unverified/i);
      expect(
        row?.licensing.bindings.every((binding) => binding.attribution?.basis === "unresolved"),
      ).toBe(true);
      const source = integration.dataSources?.find((entry) => entry.sourceId === "ioc-sealevel");
      expect(source?.usageConditions?.join(" ")).toMatch(/commercial.*permission.*originator/i);
    },
  );

  it.each(integrations)(
    "$id localizes the non-commercial and permission scope for its exact source",
    (integration) => {
      for (const locale of ["en", "de"]) {
        const row = generatePrivacySectionsFromManifests([integration], locale)
          .flatMap((section) => section.rows)
          .find((entry) => entry.service === "IOC Sea Level Station Monitoring Facility");
        expect(row?.purpose).toMatch(locale === "en" ? /non-commercial/i : /nichtkommerziell/i);
        expect(row?.purpose).toMatch(
          locale === "en" ? /permission.*originator/i : /Genehmigung.*Datenurheber/i,
        );
      }
    },
  );
});

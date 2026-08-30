import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectAirQuality } from "@openmapx/air-quality";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";

import { normalizeProviderEvidence } from "../air-quality/normalize.js";
import metadata from "./__fixtures__/metadata.json";
import { createUkAirProvider, parseUkAirRss, UkAirProviderError } from "./provider.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/current-site-levels.xml", import.meta.url)),
  "utf8",
);
const call = { signal: new AbortController().signal, deadlineAt: Date.now() + 3_000 };

describe("UK-AIR current-site RSS", () => {
  it("pins the reviewed fixture checksum and reviewer record", () => {
    const checksum = `sha256:${createHash("sha256").update(fixture).digest("hex")}`;
    expect(metadata.reviewer).toBe("OpenMapX provider-contract fixture review");
    expect(metadata.checksums["current-site-levels.xml"]).toBe(checksum);
    expect(metadata.snapshotChecksum).toBe(checksum);
  });

  it("parses stable station identity, DMS coordinates, dates, and official DAQI", () => {
    const parsed = parseUkAirRss(fixture);

    expect(parsed.publishedAt).toBe("2026-08-30T10:35:08.000Z");
    expect(parsed.sites[0]).toMatchObject({
      id: "CLL2",
      name: "London Bloomsbury",
      coordinates: [-0.125889, 51.522289],
      observedAt: "2026-08-30T10:00:00.000Z",
      value: 2,
      categoryId: "low-2",
    });
  });

  it("rejects XML entity declarations and a feed with no conforming records", () => {
    expect(() => parseUkAirRss(`<!DOCTYPE rss [<!ENTITY x "boom">]>${fixture}`)).toThrow(
      UkAirProviderError,
    );
    const inconsistent = parseUkAirRss(
      fixture.replace(
        "Current Pollution level is Low at index 2",
        "Current Pollution level is High at index 2",
      ),
    );
    expect(inconsistent.sites.map(({ id }) => id)).not.toContain("CLL2");
    expect(() =>
      parseUkAirRss(fixture.replaceAll(/Current Pollution level is [^<]*index \d+/g, "invalid")),
    ).toThrow(UkAirProviderError);
  });

  it("rejects non-canonical station links and invalid DMS components", () => {
    const credentialed = fixture.replace(
      "http://uk-air.defra.gov.uk/data/site-data?f_site_id=CLL2",
      "http://user@uk-air.defra.gov.uk/data/site-data?f_site_id=CLL2",
    );
    const invalidDms = fixture.replace(
      "51&deg;31&acute;20.24&quot;N",
      "51&deg;99&acute;20.24&quot;N",
    );

    expect(parseUkAirRss(credentialed).sites.map(({ id }) => id)).not.toContain("CLL2");
    expect(parseUkAirRss(invalidDms).sites.map(({ id }) => id)).not.toContain("CLL2");
  });

  it("rejects excessive XML nesting and element counts before DOM parsing", () => {
    const nested = `<rss>${"<x>".repeat(20)}${"</x>".repeat(20)}</rss>`;
    const nestedWithQuotedAngles = `<rss>${'<x a=">">'.repeat(20)}${"</x>".repeat(20)}</rss>`;
    const nestedUnicodeNames = `<rss>${"<é>".repeat(20)}${"</é>".repeat(20)}</rss>`;
    const crowded = `<rss>${"<x/>".repeat(4_100)}</rss>`;

    expect(() => parseUkAirRss(nested)).toThrow(/depth limit/i);
    expect(() => parseUkAirRss(nestedWithQuotedAngles)).toThrow(/depth limit/i);
    expect(() => parseUkAirRss(nestedUnicodeNames)).toThrow(/unsupported XML tag name/i);
    expect(() => parseUkAirRss(crowded)).toThrow(/element limit/i);
  });

  it("returns only the nearest official station within the conservative 25 km radius", async () => {
    const http = fakeHttpClient({ "current_site_levels.xml": fixture });
    const ctx = createMockIntegrationContext({ http });
    const provider = createUkAirProvider(ctx);
    const evidence = await provider.getCurrent?.(
      {
        latitude: 51.522289,
        longitude: -0.125889,
        evaluatedAt: "2026-08-30T10:45:00.000Z",
        countryCode: "GB",
      },
      call,
    );

    expect(evidence).toHaveLength(1);
    expect(evidence?.[0]).toMatchObject({
      providerId: "uk-air",
      sourceIds: ["uk-air-current-site-levels"],
      dataAuthority: "official-agency",
      qualityStatus: "preliminary",
      basis: "ground",
      series: [],
      observedAt: "2026-08-30T10:00:00.000Z",
      publishedAt: "2026-08-30T10:35:08.000Z",
      validUntil: "2026-08-30T12:00:00.000Z",
      spatial: {
        kind: "station",
        id: "UK-AIR-SITE-CLL2",
        name: "London Bloomsbury",
        coordinates: [-0.125889, 51.522289],
        coversRequestedPoint: true,
        coverageMethod: "nearest-station",
      },
      publishedIndices: [
        {
          methodId: "uk-daqi",
          methodRevision: "uk-air-rss-current-site-levels-v1",
          claimedStandardId: "uk-daqi-current",
          value: 2,
          displayValue: "2",
          categoryId: "low-2",
        },
      ],
    });
    expect(http.calls[0]?.options).toMatchObject({
      maxBytes: 262_144,
      contentTypes: ["text/xml", "application/xml", "application/rss+xml"],
      redirect: "error",
    });
  });

  it("returns no evidence for a point outside the station radius or an explicit non-GB hint", async () => {
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient({ "current_site_levels.xml": fixture }),
    });
    const provider = createUkAirProvider(ctx);

    await expect(
      provider.getCurrent?.(
        {
          latitude: 50.72,
          longitude: -3.53,
          evaluatedAt: "2026-08-30T10:45:00.000Z",
          countryCode: "GB",
        },
        call,
      ),
    ).resolves.toEqual([]);
    await expect(
      provider.getCurrent?.(
        {
          latitude: 51.522289,
          longitude: -0.125889,
          evaluatedAt: "2026-08-30T10:45:00.000Z",
          countryCode: "FR",
        },
        call,
      ),
    ).resolves.toEqual([]);
  });

  it("normalizes and selects the validated agency publication as local UK DAQI", async () => {
    const ctx = createMockIntegrationContext({
      http: fakeHttpClient({ "current_site_levels.xml": fixture }),
    });
    const raw = await createUkAirProvider(ctx).getCurrent?.(
      {
        latitude: 51.522289,
        longitude: -0.125889,
        evaluatedAt: "2026-08-30T10:45:00.000Z",
        countryCode: "GB",
      },
      call,
    );
    const normalized = normalizeProviderEvidence(raw?.[0], {
      targetAt: "2026-08-30T10:45:00.000Z",
      mode: "current",
      localStandardId: "uk-daqi-current",
      comparisonStandardId: null,
      subdivisionCode: "GB-ENG",
    }).evidence;
    const selected = selectAirQuality({
      evidence: [normalized],
      localStandardId: "uk-daqi-current",
      localStandardRevision: "uk-daqi-2026-04-13",
      targetAt: "2026-08-30T10:45:00.000Z",
      providerPriorities: { "uk-air": 100 },
      allowStale: true,
    });

    expect(normalized.indices[0]).toMatchObject({
      standardId: "uk-daqi-current",
      authority: "official-agency",
      derivation: "published-index",
    });
    expect(selected.primaryEvidenceId).toBe(normalized.observationId);
    expect(selected.primaryIndexId).toBe(normalized.indices[0]?.indexId);
  });
});

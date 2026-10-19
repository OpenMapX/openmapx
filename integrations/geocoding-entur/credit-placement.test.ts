import { buildAttributionPresentation } from "@openmapx/core/attribution";
import {
  createEnturGeocoderSources,
  ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS,
  type EnturGeocoderFeature,
  type EnturGeocoderSource,
} from "@openmapx/entur-client";
import {
  integrationManifestSchema,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import transitManifest from "../transit-entur/manifest.json";
import geocodingManifest from "./manifest.json";

const TERMS = "https://developer.entur.no/terms-of-service";
const CONDITION =
  "Identify the application with ET-Client-Name and comply with fair use and service rate limits.";

const nativeIds: Record<EnturGeocoderSource, string> = {
  nsr: "NSR:StopPlace:337",
  openstreetmap: "OSM:TopographicPlace:7118275595",
  "kartverket-matrikkelenadresse": "KVE:PostalAddress:285717643",
  "kartverket-stedsnavn": "KVE:PlaceName:434810",
  "custom-poi": "ENT:PointOfInterest:test",
};

describe.each([geocodingManifest, transitManifest])("$id service/data credit scopes", (raw) => {
  it.each(["map", "content", "image"] as const)(
    "keeps API conditions in details and retains exact native supplier credits on %s",
    (surface) => {
      const manifest = integrationManifestSchema.parse(raw);
      const ctx = { manifest };
      const contributors = Object.fromEntries(
        (manifest.dataSources ?? []).map(({ sourceId }) => [
          sourceId,
          resolveIntegrationContributors(ctx, [sourceId]),
        ]),
      );
      const sources = createEnturGeocoderSources({
        contributors,
        isSourceAllowed: async () => true,
      });
      let suppliersChecked = 0;
      for (const source of Object.keys(nativeIds) as EnturGeocoderSource[]) {
        const sourceId = ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source];
        const supplier = manifest.dataSources?.find((row) => row.sourceId === sourceId);
        if (!supplier) continue;
        suppliersChecked++;
        const feature: EnturGeocoderFeature = {
          type: "Feature",
          geometry: { type: "Point", coordinates: [10.7, 59.9] },
          properties: {
            id: nativeIds[source],
            names: { default: "Native result", display: "Native result, Oslo" },
            layer: source === "nsr" ? "stopPlace" : "poi",
            source,
          },
        };
        const receipts = sources.contributorsFor(feature);
        expect(receipts.map((receipt) => receipt.sourceId)).toEqual(["entur-geocoder", sourceId]);
        const [apiReceipt, supplierReceipt] = receipts;
        const api = buildAttributionPresentation(apiReceipt, surface);
        expect(api.visibleHtml).toBe("");
        expect(api.fullHtml).toContain(CONDITION);
        expect(api.fullHtml).toContain(TERMS);
        expect(api.detail?.licensing?.bindings[0]).toMatchObject({
          scope: "service",
          conditions: [CONDITION],
          attribution: {
            placement: "details",
            surfaces: ["map", "content", "image"],
            basis: "provider-terms",
            reviewedAt: "2026-10-19",
            evidenceUrls: [TERMS],
          },
        });
        expect(supplierReceipt.licensing).toEqual(supplier.licensing);
        const data = buildAttributionPresentation(supplierReceipt, surface);
        expect(data.fullHtml).toContain(supplier.attribution);
        expect(data.detail?.sourceId).toBe(sourceId);
        if (source === "openstreetmap") {
          expect(data.visibleHtml).toContain("OpenStreetMap contributors");
          expect(data.visibleHtml).toContain("ODbL");
        }
      }
      expect(suppliersChecked).toBe(manifest.id === "transit-entur" ? 1 : 5);
    },
  );
});

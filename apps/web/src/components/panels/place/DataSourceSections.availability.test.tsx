import type {
  DataSourceDetailSection,
  DataSourceMarkerStyle,
  DataSourceResult,
} from "@openmapx/core";
import {
  type I18nToken,
  isI18nToken,
  type LocaleStrings,
  resolveToken,
  type Translatable,
} from "@openmapx/integration-framework/strings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildGeoJson } from "@/integration-api/map/dataSourceFeatures";
import carSharingDe from "../../../../../../integrations/car-sharing/strings/de.json";
import carSharingEn from "../../../../../../integrations/car-sharing/strings/en.json";
import frameworkDe from "../../../../../../packages/integration-framework/strings/locales/de.json";
import frameworkEn from "../../../../../../packages/integration-framework/strings/locales/en.json";
import { StructuredSections } from "../shared/StructuredSections";
import { translateStructuredSection } from "./DataSourceSections";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/integration-api/runtime/theme", () => ({ BRAND: "#008080" }));

const resolverFor =
  (locale: "en" | "de") =>
  (value: Translatable | undefined): string => {
    if (value === undefined) return "";
    if (!isI18nToken(value)) return String(value);
    return resolveToken(value as I18nToken, {
      locale,
      fallbackLocale: "en",
      shared: { en: frameworkEn, de: frameworkDe } as LocaleStrings,
      integration: { en: carSharingEn, de: carSharingDe } as LocaleStrings,
    });
  };

/** The availability section the shared-mobility mapper emits for a static station. */
const staticAvailability: DataSourceDetailSection = {
  title: { $t: "shared.section.availability" },
  type: "table",
  rows: [
    [{ $t: "row.availableVehicles" }, { $t: "value.availabilityNotPublished" }],
    [{ $t: "row.totalCapacity" }, 3],
  ],
  sectionIcon: "info",
};

const staticResult: DataSourceResult = {
  id: "s:de-stadtteilauto/42",
  kind: "station",
  name: "Hafen",
  coordinates: [7.64, 51.95],
  source: "de-stadtteilauto",
  variant: "unknown",
  status: "unknown",
  summary: { $t: "summary.capacity", values: { count: 3 } },
  sortValues: { slots: 0 },
};

describe("car-sharing station without published availability", () => {
  it("states that availability is not published instead of showing a count", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[translateStructuredSection(staticAvailability, resolverFor("en"))]}
      />,
    );

    expect(markup).toContain("Available Cars");
    expect(markup).toContain("Not published by this source");
    expect(markup).toContain("Total Capacity");
  });

  it("summarises the cars the station holds in both locales", () => {
    expect(resolverFor("en")(staticResult.summary)).toBe("Station for 3 cars");
    expect(resolverFor("de")(staticResult.summary)).toBe("Station für 3 Autos");
    expect(resolverFor("en")({ $t: "summary.capacity", values: { count: 0 } })).toBe(
      "No cars listed",
    );
  });

  it("marks the map feature with neither an empty nor an inactive state", () => {
    const markerStyle: DataSourceMarkerStyle = {
      variantColors: { available: "#2196F3", empty: "#F44336", inactive: "#9E9E9E" },
      defaultColor: "#2196F3",
      inactiveOpacity: 0.5,
      iconPath: "M0 0",
    };
    const [feature] = buildGeoJson(
      [staticResult],
      resolverFor("en"),
      undefined,
      markerStyle,
    ).features;

    expect(feature.properties).toMatchObject({
      variant: "unknown",
      status: "unknown",
      availState: "unknown",
    });
  });
});

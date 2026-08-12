import { escapeHtml } from "@openmapx/core";
import type { EffisProperties, NifcProperties, NoaaSmokeProperties } from "./types.js";

const ACRES_TO_HECTARES = 0.40468564224;

export const NOAA_SMOKE_OPACITY = {
  light: 0.08,
  medium: 0.15,
  heavy: 0.24,
} as const;

export const NIFC_PERIMETER_STYLE = {
  fillColor: "#dc5a36",
  fillOpacity: 0.18,
  lineColor: "#b91c1c",
  lineWidth: 1.5,
} as const;

export const EFFIS_BURNED_AREA_STYLE = {
  fillColor: "#8b6f47",
  fillOpacity: 0.2,
  lineColor: "#5f4630",
  lineWidth: 1,
  lineDasharray: [3, 2] as number[],
} as const;

export const NOAA_SMOKE_STYLE = {
  fillColor: "#94a3b8",
  lineColor: "#64748b",
  lineOpacity: 0.35,
  lineWidth: 0.75,
} as const;

export type WildfireMeasurementUnitKey = "acres" | "hectares";

export interface WildfirePopupMeasurement {
  formatted: string;
  unitKey: WildfireMeasurementUnitKey;
}

export type WildfirePopupValue =
  | string
  | { kind: "measurements"; values: WildfirePopupMeasurement[] }
  | { kind: "density"; value: NoaaSmokeProperties["density"] };

export interface WildfirePopupField {
  key: string;
  value: WildfirePopupValue;
}

export interface WildfirePopupModel {
  title:
    | { kind: "escaped"; value: string }
    | { kind: "message"; key: "satelliteDerivedBurnedArea" | "observedSmoke" };
  fields: WildfirePopupField[];
  caveatKeys: Array<"effisBurnedAreaCaveat" | "noaaObservedSmokeCaveat">;
}

export function acresToHectares(acres: number): number {
  return acres * ACRES_TO_HECTARES;
}

export function formatWildfireDate(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function formatAreaNumber(value: number | undefined, locale: string): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

function escapedField(key: string, value: string | undefined): WildfirePopupField | null {
  if (!value) return null;
  return { key, value: escapeHtml(value) };
}

function dateField(
  key: string,
  value: string | undefined,
  locale: string,
): WildfirePopupField | null {
  const formatted = formatWildfireDate(value, locale);
  return formatted ? { key, value: formatted } : null;
}

function compactFields(fields: Array<WildfirePopupField | null | undefined>): WildfirePopupField[] {
  return fields.filter(
    (field): field is WildfirePopupField => field !== null && field !== undefined,
  );
}

export function buildNifcPopupModel(
  properties: NifcProperties,
  locale: string,
): WildfirePopupModel {
  const areaAcres = formatAreaNumber(properties.areaAcres, locale);
  const areaHectares =
    properties.areaAcres !== undefined &&
    Number.isFinite(properties.areaAcres) &&
    properties.areaAcres >= 0
      ? formatAreaNumber(acresToHectares(properties.areaAcres), locale)
      : null;
  const reportedArea =
    areaAcres && areaHectares
      ? {
          kind: "measurements" as const,
          values: [
            { formatted: areaAcres, unitKey: "acres" as const },
            { formatted: areaHectares, unitKey: "hectares" as const },
          ],
        }
      : null;
  const containment =
    properties.containmentPercent !== undefined &&
    Number.isFinite(properties.containmentPercent) &&
    properties.containmentPercent >= 0 &&
    properties.containmentPercent <= 100
      ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(properties.containmentPercent)}%`
      : null;

  return {
    title: { kind: "escaped", value: escapeHtml(properties.name) },
    fields: compactFields([
      reportedArea ? { key: "reportedArea", value: reportedArea } : null,
      containment ? { key: "containment", value: containment } : null,
      dateField("observed", properties.observedAt, locale),
      dateField("updated", properties.updatedAt, locale),
      dateField("discovered", properties.discoveredAt, locale),
      escapedField("region", properties.region),
      escapedField("cause", properties.cause),
    ]),
    caveatKeys: [],
  };
}

export function buildEffisPopupModel(
  properties: EffisProperties,
  locale: string,
): WildfirePopupModel {
  const area = formatAreaNumber(properties.areaHectares, locale);

  return {
    title: { kind: "message", key: "satelliteDerivedBurnedArea" },
    fields: compactFields([
      area
        ? {
            key: "area",
            value: {
              kind: "measurements",
              values: [{ formatted: area, unitKey: "hectares" }],
            },
          }
        : null,
      dateField("detected", properties.detectedAt, locale),
      dateField("updated", properties.updatedAt, locale),
      escapedField("region", properties.region),
      escapedField("locality", properties.locality),
      escapedField("country", properties.countryCode),
      escapedField("sourceClass", properties.sourceClass),
    ]),
    caveatKeys: ["effisBurnedAreaCaveat"],
  };
}

export function buildNoaaSmokePopupModel(
  properties: NoaaSmokeProperties,
  locale: string,
): WildfirePopupModel {
  return {
    title: { kind: "message", key: "observedSmoke" },
    fields: compactFields([
      { key: "density", value: { kind: "density", value: properties.density } },
      escapedField("satellite", properties.satellite),
      dateField("started", properties.startedAt, locale),
      dateField("ended", properties.endedAt, locale),
    ]),
    caveatKeys: ["noaaObservedSmokeCaveat"],
  };
}

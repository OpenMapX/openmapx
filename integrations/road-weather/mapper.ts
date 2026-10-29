import {
  type Attribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  type DataSourceResult,
  validObservedAt,
} from "@openmapx/core";
import { siteAttributions } from "@openmapx/integration-framework";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type {
  RoadSurfaceSensor,
  RoadSurfaceState,
  RoadWeatherAir,
  RoadWeatherStation,
  RoadWeatherValue,
} from "@openmapx/mobility-core/road-weather";

type Row = [I18nToken, Translatable];

/** What lies on the road, as the map colours it, from the most to the least hazardous. */
export type SurfaceCondition = "icy" | "snowy" | "wet" | "dry";

const CONDITION_OF: Partial<Record<RoadSurfaceState, SurfaceCondition>> = {
  frost: "icy",
  ice: "icy",
  black_ice: "icy",
  snow: "snowy",
  packed_snow: "snowy",
  slush: "snowy",
  damp: "wet",
  wet: "wet",
  chemically_wet: "wet",
  standing_water: "wet",
  flooded: "wet",
  dry: "dry",
};
const SEVERITY: readonly SurfaceCondition[] = ["icy", "snowy", "wet", "dry"];

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** A station that reports nothing current says nothing about the road now. */
const reporting = (station: RoadWeatherStation): boolean =>
  station.status === "operational" && !station.stale;

/** The surface sensor whose state is the most hazardous one the station measures. */
function worstSensor(station: RoadWeatherStation): RoadSurfaceSensor | undefined {
  const rank = (sensor: RoadSurfaceSensor) => {
    const condition = sensor.state ? CONDITION_OF[sensor.state.value] : undefined;
    return condition === undefined ? SEVERITY.length : SEVERITY.indexOf(condition);
  };
  return station.surface
    .filter((s) => s.state && CONDITION_OF[s.state.value])
    .reduce<RoadSurfaceSensor | undefined>(
      (worst, s) => (worst === undefined || rank(s) < rank(worst) ? s : worst),
      undefined,
    );
}

/** The marker variant: the most hazardous surface the station measures now. */
export function variantOf(station: RoadWeatherStation): SurfaceCondition | "unknown" {
  if (!reporting(station)) return "unknown";
  const state = worstSensor(station)?.state?.value;
  return (state && CONDITION_OF[state]) ?? "unknown";
}

/** A closed station or one without current values dims. */
function statusOf(station: RoadWeatherStation): string {
  return reporting(station) ? "operational" : "non-operational";
}

/** The coldest road surface the station measures, since ice forms there first. */
function coldestSurface(station: RoadWeatherStation): number | undefined {
  const temperatures = station.surface.flatMap((s) =>
    s.temperatureC === undefined ? [] : [s.temperatureC.value],
  );
  return temperatures.length > 0 ? Math.min(...temperatures) : undefined;
}

/** The summary, with a fault its operator suspects or has confirmed after it. */
function summaryOf(station: RoadWeatherStation): I18nToken {
  const summary = valuesSummaryOf(station);
  if (station.status === "temporarily_closed" || !station.fault) return summary;
  return token("summary.withFault", { summary, fault: token(`fault.${station.fault.level}`) });
}

/** The surface state, the coldest road temperature and the air temperature, as far as measured. */
function valuesSummaryOf(station: RoadWeatherStation): I18nToken {
  if (station.status === "temporarily_closed") return token("summary.closed");
  if (station.stale) return token("summary.stale");
  const state = worstSensor(station)?.state?.value;
  const road = coldestSurface(station);
  const air = station.air.temperatureC?.value;
  const parts = [
    ...(state ? [token(`state.${state}`)] : []),
    ...(road !== undefined ? [token("summary.road", { value: road })] : []),
    ...(air !== undefined ? [token("summary.air", { value: air })] : []),
  ];
  const [first, second, third] = parts;
  if (first === undefined) {
    // A station of optical sensors only measures grip, not state or temperature.
    const grip = station.surface.find((s) => s.friction)?.friction?.value;
    return grip === undefined ? token("summary.noValues") : token("summary.grip", { value: grip });
  }
  if (second === undefined) return first;
  if (third === undefined) return token("summary.two", { first, second });
  return token("summary.three", { first, second, third });
}

/** A station's title when its sources name it nothing. */
function fallbackNameOf(station: RoadWeatherStation): { fallbackName?: I18nToken } {
  return station.name ? {} : { fallbackName: token("fallbackName") };
}

function stationCredits(station: RoadWeatherStation): Attribution[] | undefined {
  if (station.attributions.length === 0) return undefined;
  return snapshotContributors(station.attributions);
}

/** The newest time among measured values, as the section's caption states it. */
function newestOf(values: readonly (RoadWeatherValue<unknown> | undefined)[]): string | undefined {
  return values
    .flatMap((v) => (v?.observedAt ? [v.observedAt] : []))
    .reduce<string | undefined>(
      (newest, at) => (newest === undefined || Date.parse(at) > Date.parse(newest) ? at : newest),
      undefined,
    );
}

function measuredCaption(values: readonly (RoadWeatherValue<unknown> | undefined)[]) {
  const at = validObservedAt(newestOf(values));
  return at ? { caption: token("caption.measured"), captionTimestamp: at } : {};
}

const celsius = (value: number) => token("value.celsius", { value });
const millimetres = (value: number) => token("value.mm", { value });

function surfaceSection(sensor: RoadSurfaceSensor, count: number): DataSourceDetailSection | null {
  const rows: Row[] = [];
  if (sensor.state) rows.push([token("row.surface"), token(`state.${sensor.state.value}`)]);
  if (sensor.temperatureC)
    rows.push([token("row.roadTemperature"), celsius(sensor.temperatureC.value)]);
  if (sensor.freezingPointC) {
    rows.push([token("row.freezingPoint"), celsius(sensor.freezingPointC.value)]);
  }
  if (sensor.subsurfaceTemperatureC) {
    rows.push([token("row.groundTemperature"), celsius(sensor.subsurfaceTemperatureC.value)]);
  }
  if (sensor.friction) {
    rows.push([token("row.grip"), token("value.friction", { value: sensor.friction.value })]);
  }
  if (sensor.waterFilmMm) rows.push([token("row.water"), millimetres(sensor.waterFilmMm.value)]);
  if (sensor.snowDepthMm) rows.push([token("row.snow"), millimetres(sensor.snowDepthMm.value)]);
  if (sensor.iceThicknessMm)
    rows.push([token("row.ice"), millimetres(sensor.iceThicknessMm.value)]);
  if (sensor.saltKgM3) {
    rows.push([token("row.salt"), token("value.salt", { value: sensor.saltKgM3.value })]);
  }
  if (rows.length === 0) return null;
  const { index: _index, ...values } = sensor;
  return {
    title:
      count === 1 ? token("section.surface") : token("section.surfaceSensor", { n: sensor.index }),
    type: "table",
    rows,
    sectionIcon: "directions_car",
    ...measuredCaption(Object.values(values)),
  };
}

function compassOf(degrees: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
}

function windOf(air: RoadWeatherAir): I18nToken | undefined {
  const speed = air.windSpeedMs?.value;
  if (speed === undefined) return undefined;
  const from = air.windDirectionDeg?.value;
  return from === undefined || speed === 0
    ? token("value.wind", { speed })
    : token("value.windFrom", { speed, direction: token(`compass.${compassOf(from)}`) });
}

function visibilityOf(metres: number): I18nToken {
  return metres >= 1000
    ? token("value.km", { value: metres / 1000 })
    : token("value.m", { value: Math.round(metres) });
}

function precipitationOf(air: RoadWeatherAir): I18nToken | undefined {
  const type = air.precipitation?.value;
  const rate = air.precipitationMmH?.value;
  if (type === undefined) {
    return rate === undefined ? undefined : token("value.rate", { value: rate });
  }
  const label = token(`precipitation.${type}`);
  return rate === undefined || rate === 0 || type === "none"
    ? label
    : token("value.precipitationWithRate", { type: label, rate });
}

function airSection(air: RoadWeatherAir): DataSourceDetailSection | null {
  const rows: Row[] = [];
  if (air.temperatureC) rows.push([token("row.airTemperature"), celsius(air.temperatureC.value)]);
  if (air.dewPointC) rows.push([token("row.dewPoint"), celsius(air.dewPointC.value)]);
  if (air.humidityPct) {
    rows.push([token("row.humidity"), token("value.percent", { value: air.humidityPct.value })]);
  }
  const wind = windOf(air);
  if (wind) rows.push([token("row.wind"), wind]);
  if (air.windGustMs)
    rows.push([token("row.gusts"), token("value.wind", { speed: air.windGustMs.value })]);
  if (air.visibilityM) rows.push([token("row.visibility"), visibilityOf(air.visibilityM.value)]);
  const precipitation = precipitationOf(air);
  if (precipitation) rows.push([token("row.precipitation"), precipitation]);
  if (rows.length === 0) return null;
  return {
    title: token("section.air"),
    type: "table",
    rows,
    sectionIcon: "thermostat",
    ...measuredCaption(Object.values(air)),
  };
}

/** Why a station shows no values: it is out of service, or has reported none lately. */
function silentSection(station: RoadWeatherStation): DataSourceDetailSection {
  const updatedAt = validObservedAt(station.updatedAt);
  return {
    title: token("section.readings"),
    type: "text",
    content: token(station.status === "temporarily_closed" ? "text.closed" : "text.stale"),
    sectionIcon: "info",
    ...(updatedAt ? { caption: token("caption.lastReading"), captionTimestamp: updatedAt } : {}),
  };
}

/** A fault in the station's equipment, which its values are shown beside, and since when. */
function faultSection(fault: NonNullable<RoadWeatherStation["fault"]>): DataSourceDetailSection {
  const since = validObservedAt(fault.since);
  return {
    title: token("section.status"),
    type: "text",
    content: token(`text.fault.${fault.level}`),
    sectionIcon: "warning",
    ...(since ? { caption: token("caption.since"), captionTimestamp: since } : {}),
  };
}

function infoSection(station: RoadWeatherStation): DataSourceDetailSection | null {
  const rows: Row[] = [];
  if (station.road) rows.push([token("row.road"), station.road]);
  if (station.municipality) rows.push([token("row.municipality"), station.municipality]);
  const provider = station.attributions[0]?.name;
  if (provider) rows.push([token("row.provider"), provider]);
  if (rows.length === 0) return null;
  return { title: sharedT.section.info, type: "table", rows, sectionIcon: "info" };
}

export function mapStationToResult(station: RoadWeatherStation): DataSourceResult {
  const observedAt = validObservedAt(station.updatedAt);
  const road = coldestSurface(station);
  const result: DataSourceResult = {
    id: station.id,
    name: station.name,
    ...fallbackNameOf(station),
    coordinates: station.coordinates,
    source: station.sources[0] ?? "unknown",
    sources: [...station.sources],
    contributors: siteAttributions([station]),
    variant: variantOf(station),
    status: statusOf(station),
    summary: summaryOf(station),
    ...(reporting(station) && road !== undefined ? { sortValues: { roadTemperature: road } } : {}),
    ...(observedAt ? { observedAt } : {}),
  };
  const attributions = stationCredits(station);
  if (attributions) result.attributions = attributions;
  return result;
}

/**
 * The station's detail: what each surface sensor measures on the road (its
 * state, temperatures, grip and what lies on it), then the weather above
 * it, each with the time it was measured; or, for a station out of service
 * or silent lately, why it shows nothing. Then its road, municipality and
 * provider.
 */
export function mapStationToDetail(station: RoadWeatherStation): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];
  if (station.fault && station.status !== "temporarily_closed") {
    sections.push(faultSection(station.fault));
  }
  if (reporting(station)) {
    for (const sensor of station.surface) {
      const section = surfaceSection(sensor, station.surface.length);
      if (section) sections.push(section);
    }
    const air = airSection(station.air);
    if (air) sections.push(air);
  }
  if (sections.length === 0) sections.push(silentSection(station));
  const info = infoSection(station);
  if (info) sections.push(info);
  const detail: DataSourceDetail = {
    id: station.id,
    sources: [...station.sources],
    contributors: siteAttributions([station]),
    name: station.name,
    ...fallbackNameOf(station),
    coordinates: station.coordinates,
    sections,
  };
  const attributions = stationCredits(station);
  if (attributions) detail.attributions = attributions;
  return detail;
}

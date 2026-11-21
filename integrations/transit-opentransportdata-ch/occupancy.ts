import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorsForRecords, snapshotContributors } from "@openmapx/mobility-core/contributors";
import type {
  Departure,
  OccupancyLevel,
  TransitServiceInfo,
  TripLeg,
  TripPlan,
} from "@openmapx/mobility-core/transit";
import {
  mapSwissOccupancy,
  nestedFieldContributors,
  normalizeText,
  retainedFieldContributors,
  type SwissProviderRuntime,
  stripProviderPrefix,
  uniqueStrings,
} from "./common.js";
import {
  resolveSwissStopIdentity,
  type SwissOccupancyForecastFareClassLevel,
  type SwissOccupancyForecastSection,
  type SwissOccupancyForecastTrain,
  type SwissStopDatasets,
} from "./datasets.js";
import { extractSwissTrainNumber } from "./formation.js";

const SWISS_TIMEZONE = "Europe/Zurich";
const SWISS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: SWISS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function collectSwissStopRefs(rawRef: string, datasets: SwissStopDatasets): string[] {
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  return uniqueStrings([
    rawRef,
    identity.didok,
    identity.servicePointSloid,
    identity.stopPointSloid,
  ]);
}

function swissDateTimeParts(iso: string | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = SWISS_DATE_TIME_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    !values.hour ||
    !values.minute ||
    !values.second
  ) {
    return null;
  }
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function swissDayShift(
  iso: string | undefined,
  operatingDayRef: string | undefined,
): number | undefined {
  const parts = swissDateTimeParts(iso);
  if (!parts || !operatingDayRef) return undefined;
  const parseDay = (value: string) => {
    const [year, month, day] = value.split("-").map((segment) => Number.parseInt(segment, 10));
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    )
      return null;
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  const actual = parseDay(parts.date);
  const scheduled = parseDay(operatingDayRef);
  if (actual == null || scheduled == null) return undefined;
  return actual - scheduled;
}

function mapSwissForecastOccupancyClasses(
  levels: SwissOccupancyForecastFareClassLevel[] | undefined,
): TransitServiceInfo["occupancyClasses"] | undefined {
  if (!levels?.length) return undefined;
  const classes: NonNullable<TransitServiceInfo["occupancyClasses"]> = {};
  for (const level of levels) {
    const mapped = mapSwissOccupancy(level.occupancyLevel);
    if (!mapped) continue;
    if (normalizeText(level.fareClass).toLowerCase() === "firstclass") {
      classes.firstClass = mapped;
      continue;
    }
    if (normalizeText(level.fareClass).toLowerCase() === "secondclass") {
      classes.secondClass = mapped;
    }
  }
  return classes.firstClass || classes.secondClass ? classes : undefined;
}

function pickSwissForecastOccupancy(
  classes: TransitServiceInfo["occupancyClasses"] | undefined,
): OccupancyLevel | undefined {
  if (!classes) return undefined;
  if (classes.secondClass) return classes.secondClass;
  if (classes.firstClass) return classes.firstClass;
  return undefined;
}

function scoreSwissOccupancySection(
  section: SwissOccupancyForecastSection,
  options: {
    dayShift?: number;
    stopRefs: Set<string>;
    stopName?: string;
    time?: string;
  },
): number {
  let score = 0;
  if (options.dayShift != null && section.departureDayShift === options.dayShift) score += 8;
  if (section.departureStationId && options.stopRefs.has(section.departureStationId)) score += 10;
  if (
    options.stopName &&
    normalizeText(section.departureStationName).toLowerCase() === options.stopName.toLowerCase()
  ) {
    score += 4;
  }
  if (options.time && section.departureTime === options.time) score += 6;
  return score;
}

function swissOccupancyTrainKeys(serviceInfo: TransitServiceInfo): Set<string> {
  const keys = new Set<string>();
  for (const candidate of uniqueStrings([
    serviceInfo.trainNumber,
    ...(serviceInfo.formation ?? []).map((ref) => ref.trainNumber),
  ])) {
    const normalized = normalizeText(candidate);
    if (normalized) keys.add(normalized);
    const extracted = extractSwissTrainNumber(candidate);
    if (extracted) keys.add(extracted);
  }
  return keys;
}

function swissForecastTrainKeys(train: SwissOccupancyForecastTrain): Set<string> {
  const keys = new Set<string>();
  const normalized = normalizeText(train.trainNumber);
  if (normalized) keys.add(normalized);
  const extracted = extractSwissTrainNumber(train.trainNumber);
  if (extracted) keys.add(extracted);
  return keys;
}

export async function resolveSwissOccupancyForecast(
  runtime: SwissProviderRuntime,
  serviceInfo: TransitServiceInfo | undefined,
  options: {
    scheduledAt?: string;
    stopId?: string;
    stopName?: string;
  } = {},
): Promise<{
  contributors: readonly Attribution[];
  occupancy: OccupancyLevel;
  occupancyClasses?: TransitServiceInfo["occupancyClasses"];
  occupancyRaw: string;
  occupancyUpdatedAt?: string;
  source: string;
} | null> {
  if (!serviceInfo?.operatorOrganisationNumber || !serviceInfo.operatingDayRef) {
    return null;
  }

  const dataset = await runtime.datasets
    .loadSwissOccupancyForecastDataset(
      serviceInfo.operatingDayRef,
      serviceInfo.operatorOrganisationNumber,
    )
    .catch(() => null);
  if (!dataset?.trains?.length) return null;

  const trainKeys = swissOccupancyTrainKeys(serviceInfo);
  const journeyRef = normalizeText(serviceInfo.journeyRef);
  const lineRef = normalizeText(serviceInfo.lineRef);
  if (trainKeys.size === 0 && !journeyRef && !lineRef) {
    return null;
  }

  const trains = dataset.trains.filter((train) => {
    if ([...swissForecastTrainKeys(train)].some((key) => trainKeys.has(key))) {
      return true;
    }
    if (journeyRef && normalizeText(train.journeyRef) === journeyRef) {
      return true;
    }
    if (lineRef && normalizeText(train.lineRef) === lineRef) {
      return true;
    }
    return false;
  });
  if (!trains.length) return null;

  const datasets = options.stopId
    ? await runtime.datasets.loadSwissStopDatasets().catch(() => null)
    : null;
  const stopRefs = new Set<string>(
    options.stopId && datasets
      ? collectSwissStopRefs(stripProviderPrefix(options.stopId), datasets)
      : [],
  );
  const stopName = normalizeText(options.stopName);
  const time = swissDateTimeParts(options.scheduledAt)?.time;
  const dayShift = swissDayShift(options.scheduledAt, serviceInfo.operatingDayRef);

  let bestSection: SwissOccupancyForecastSection | null = null;
  let bestTrainScore = -1;
  let bestSectionScore = -1;

  for (const train of trains) {
    let trainScore = 0;
    if ([...swissForecastTrainKeys(train)].some((key) => trainKeys.has(key))) {
      trainScore += 6;
    }
    if (journeyRef && normalizeText(train.journeyRef) === journeyRef) {
      trainScore += 4;
    }
    if (lineRef && normalizeText(train.lineRef) === lineRef) {
      trainScore += 2;
    }

    const sections = train.sections ?? [];
    if (!sections.length) continue;
    const scoredSections = sections
      .map((section) => ({
        score: scoreSwissOccupancySection(section, {
          dayShift,
          stopName,
          stopRefs,
          time,
        }),
        section,
      }))
      .sort((left, right) => right.score - left.score);
    const bestForTrain = scoredSections[0];
    if (!bestForTrain) continue;
    if (
      trainScore > bestTrainScore ||
      (trainScore === bestTrainScore && bestForTrain.score > bestSectionScore)
    ) {
      bestTrainScore = trainScore;
      bestSectionScore = bestForTrain.score;
      bestSection = bestForTrain.section;
    }
  }

  const levels =
    bestSection?.expectedDepartureOccupancies ?? bestSection?.expectedArrivalOccupancies;
  const classes = mapSwissForecastOccupancyClasses(levels);
  const occupancy = pickSwissForecastOccupancy(classes);
  if (!occupancy) return null;

  return {
    contributors: snapshotContributors(dataset.contributors ?? []),
    occupancy,
    occupancyClasses: classes,
    occupancyRaw:
      levels?.find((level) => normalizeText(level.fareClass).toLowerCase() === "secondclass")
        ?.occupancyLevel ||
      levels?.[0]?.occupancyLevel ||
      occupancy,
    occupancyUpdatedAt: dataset.lastUpdated,
    source: "opentransportdata.swiss/occupancy-forecast",
  };
}

export function applySwissOccupancyForecastToServiceInfo(
  serviceInfo: TransitServiceInfo | undefined,
  forecast: {
    contributors: readonly Attribution[];
    occupancy: OccupancyLevel;
    occupancyClasses?: TransitServiceInfo["occupancyClasses"];
    occupancyRaw: string;
    occupancyUpdatedAt?: string;
    source: string;
  } | null,
): TransitServiceInfo | undefined {
  if (!serviceInfo || !forecast) return serviceInfo;
  const candidate = {
    occupancy: forecast.occupancy,
    occupancyClasses: forecast.occupancyClasses,
    occupancyRaw: forecast.occupancyRaw,
    occupancySource: forecast.source,
    occupancyUpdatedAt: forecast.occupancyUpdatedAt,
  };
  const retained = Object.entries(candidate).filter(
    ([field, value]) => value != null && serviceInfo[field as keyof TransitServiceInfo] == null,
  );
  if (!retained.length) return serviceInfo;
  const receipts = snapshotContributors(forecast.contributors);
  return {
    ...serviceInfo,
    ...Object.fromEntries(retained),
    contributors: snapshotContributors(serviceInfo.contributors ?? [], receipts),
    fieldContributors: {
      ...retainedFieldContributors(serviceInfo),
      ...Object.fromEntries(retained.map(([field]) => [field, snapshotContributors(receipts)])),
    },
  };
}

export function applySwissOccupancyForecast<T extends Departure | TripLeg>(
  record: T,
  forecast: NonNullable<Awaited<ReturnType<typeof resolveSwissOccupancyForecast>>>,
): T {
  const serviceInfo = applySwissOccupancyForecastToServiceInfo(record.serviceInfo, forecast);
  const changedOccupancy = record.occupancy == null;
  if (!changedOccupancy && serviceInfo === record.serviceInfo) return record;
  return {
    ...record,
    contributors: snapshotContributors(record.contributors ?? [], forecast.contributors),
    occupancy: record.occupancy ?? forecast.occupancy,
    serviceInfo,
    fieldContributors: {
      ...retainedFieldContributors(record),
      ...(changedOccupancy ? { occupancy: snapshotContributors(forecast.contributors) } : {}),
      ...(serviceInfo && serviceInfo !== record.serviceInfo
        ? nestedFieldContributors(serviceInfo, "serviceInfo")
        : {}),
    },
  };
}

export async function enrichSwissTripPlanOccupancy(
  runtime: SwissProviderRuntime,
  plan: TripPlan | null,
): Promise<TripPlan | null> {
  if (!plan) return null;
  const itineraries = await Promise.all(
    plan.itineraries.map(async (itinerary) => {
      const legs = await Promise.all(
        itinerary.legs.map(async (leg) => {
          if (leg.mode === "walking" || leg.occupancy || !leg.serviceInfo) return leg;
          const forecast = await resolveSwissOccupancyForecast(runtime, leg.serviceInfo, {
            scheduledAt: leg.startTime,
            stopId: leg.from.stopId,
            stopName: leg.from.name,
          });
          if (!forecast) return leg;
          return applySwissOccupancyForecast(leg, forecast);
        }),
      );
      return {
        ...itinerary,
        contributors: snapshotContributors(
          contributorsForRecords(legs),
          itinerary.fare?.contributors ?? [],
        ),
        legs,
      };
    }),
  );
  return {
    ...plan,
    contributors: contributorsForRecords(itineraries),
    itineraries,
  };
}

import type { TransitFormationDetail } from "@openmapx/mobility-core/transit";
import type { OjpService } from "@openmapx/mobility-formats";
import {
  extractSwissOrganisationNumber,
  normalizeSwissLookupKey,
  normalizeSwissOperatingDate,
  normalizeText,
  providerId,
  type SwissProviderRuntime,
  swissContributors,
  uniqueStrings,
} from "./common.js";
import {
  resolveSwissStopIdentity,
  type SwissBusinessOrganisation,
  type SwissStopDatasets,
} from "./datasets.js";
import { collectServiceOperatorRefs } from "./ojp-map.js";

interface SwissFormationStopPoint {
  designationOfficial?: string;
  uic?: string;
}

interface SwissFormationScheduledStop {
  stopPoint?: SwissFormationStopPoint;
  stopTime?: string;
  track?: string;
}

interface SwissFormationStopRecord {
  scheduledStop?: SwissFormationScheduledStop;
  sector?: string;
}

export interface SwissFormationJourneyResponse {
  formations?: Array<{
    formationVehicles?: Array<{
      formationVehicleStops?: SwissFormationStopRecord[];
      metaInformation?: {
        id?: string;
        length?: number;
        order?: number;
        vehicleNumber?: string;
        vehicleTypeAbbreviation?: string;
        vehicleTypeDesignation?: string;
      };
      vehicleMetaInformation?: {
        id?: string;
        length?: number;
        order?: number;
        vehicleNumber?: string;
        vehicleTypeAbbreviation?: string;
        vehicleTypeDesignation?: string;
      };
      vehicleProperties?: {
        climated?: boolean;
        closed?: boolean;
        lowFloor?: boolean;
        numberBicycleHooks?: number;
        numberFirstClassSeats?: number;
        numberSecondClassSeats?: number;
        numberWheelchairPlaces?: number;
        toilet?: boolean;
      };
    }>;
    metaInformation?: {
      length?: number;
      numberSeats?: number;
      numberVehicles?: number;
    };
  }>;
  formationsAtScheduledStops?: Array<{
    formationShort?: { formationShortString?: string };
    scheduledStop?: SwissFormationScheduledStop;
  }>;
  journeyMetaInformation?: {
    SJYID?: string;
    operationDate?: string;
  };
  lastUpdate?: string;
  trainMetaInformation?: {
    trainNumber?: string;
  };
}

const SWISS_FORMATION_EVU_BY_ORGANISATION_NUMBER: Record<string, string> = {
  "11": "SBBP",
  "29": "MBC",
  "33": "BLSP",
  "44": "TRN",
  "53": "TPF",
  "65": "THURBO",
  "72": "RhB",
  "73": "TRN",
  "82": "SOB",
  "86": "ZB",
  "153": "TRN",
  "792": "TRN",
  "796": "TRN",
};
const SWISS_FORMATION_EVU_BY_ABBREVIATION: Record<string, string> = {
  bls: "BLSP",
  mbc: "MBC",
  oebb: "OeBB",
  rhb: "RhB",
  sbb: "SBBP",
  sob: "SOB",
  tpf: "TPF",
  thurbo: "THURBO",
  trn: "TRN",
  vdbb: "VDBB",
  zb: "ZB",
};

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

export function extractSwissTrainNumber(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return normalized;
  const matches = [...normalized.matchAll(/(\d{1,6})/g)];
  return matches.at(-1)?.[1];
}

function resolveSwissFormationEvu(
  operatorMetadata: SwissBusinessOrganisation | undefined,
  operatorRefs: string[],
): string | undefined {
  const organisationNumber =
    operatorMetadata?.organisationNumber ??
    operatorRefs.map((ref) => extractSwissOrganisationNumber(ref)).find(Boolean);
  if (organisationNumber) {
    const byOrganisation = SWISS_FORMATION_EVU_BY_ORGANISATION_NUMBER[organisationNumber];
    if (byOrganisation) return byOrganisation;
  }

  const abbreviations = uniqueStrings([operatorMetadata?.abbreviation, ...operatorRefs]);
  for (const abbreviation of abbreviations) {
    const normalized = normalizeSwissLookupKey(abbreviation);
    if (!normalized) continue;
    const direct = SWISS_FORMATION_EVU_BY_ABBREVIATION[normalized];
    if (direct) return direct;
    const root = SWISS_FORMATION_EVU_BY_ABBREVIATION[normalized.split("-")[0] || normalized];
    if (root) return root;
  }
  return undefined;
}

export function buildSwissFormationRequest(
  service: OjpService | undefined,
  operatorMetadata: SwissBusinessOrganisation | undefined,
): { evu: string; operationDate: string; trainNumber: string } | null {
  if (!service) return null;
  const operatorRefs = collectServiceOperatorRefs(service);
  const evu = resolveSwissFormationEvu(operatorMetadata, operatorRefs);
  const operationDate = normalizeSwissOperatingDate(
    service.operatingDayRef ?? service.datedTrainNumberRefs?.[0]?.operatingDayRef,
  );
  const trainNumber = uniqueStrings([
    service.trainNumber,
    ...(service.datedTrainNumberRefs ?? []).map((ref) => ref.trainNumber),
    service.publishedServiceName,
    service.publishedLineName,
  ])
    .map((value) => extractSwissTrainNumber(value))
    .find((value): value is string => Boolean(value));
  if (!evu || !operationDate || !trainNumber) return null;
  return { evu, operationDate, trainNumber };
}

function mapSwissFormationStopId(
  stopPoint: SwissFormationStopPoint | undefined,
  datasets: SwissStopDatasets,
): string | undefined {
  const rawRef = normalizeText(stopPoint?.uic);
  if (!rawRef) return undefined;
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  return providerId(identity.didok || identity.servicePointSloid || rawRef);
}

export function mapSwissFormationDetails(
  runtime: SwissProviderRuntime,
  journey: SwissFormationJourneyResponse,
  datasets: SwissStopDatasets,
  evu: string,
): TransitFormationDetail | undefined {
  const formations = journey.formations ?? [];
  const stops = (journey.formationsAtScheduledStops ?? []).map((entry) => ({
    platform: entry.scheduledStop?.track,
    scheduledAt: entry.scheduledStop?.stopTime,
    shortFormation: entry.formationShort?.formationShortString,
    stopId: mapSwissFormationStopId(entry.scheduledStop?.stopPoint, datasets),
    stopName: entry.scheduledStop?.stopPoint?.designationOfficial,
  }));
  const vehicles = formations.flatMap((formation) =>
    (formation.formationVehicles ?? []).map((vehicle) => {
      const meta = vehicle.vehicleMetaInformation ?? vehicle.metaInformation;
      const stop = firstDefined(
        ...(vehicle.formationVehicleStops ?? []).map((entry) => entry.sector),
      );
      return {
        bikeSpaces: vehicle.vehicleProperties?.numberBicycleHooks,
        closed: vehicle.vehicleProperties?.closed,
        hasAirConditioning: vehicle.vehicleProperties?.climated,
        hasLowFloorAccess: vehicle.vehicleProperties?.lowFloor,
        hasToilet: vehicle.vehicleProperties?.toilet,
        id: meta?.id,
        lengthMeters: meta?.length,
        order: meta?.order,
        sector: stop,
        seatsFirstClass: vehicle.vehicleProperties?.numberFirstClassSeats,
        seatsSecondClass: vehicle.vehicleProperties?.numberSecondClassSeats,
        typeCode: meta?.vehicleTypeAbbreviation,
        typeName: meta?.vehicleTypeDesignation,
        wheelchairSpaces: vehicle.vehicleProperties?.numberWheelchairPlaces,
      };
    }),
  );
  const shortFormation = stops.find((stop) => stop.shortFormation)?.shortFormation;
  const totalSeats = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.numberSeats ?? 0),
    0,
  );
  const vehicleCount = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.numberVehicles ?? 0),
    0,
  );
  const lengthMeters = formations.reduce(
    (sum, formation) => sum + (formation.metaInformation?.length ?? 0),
    0,
  );
  if (!stops.length && !vehicles.length && !vehicleCount && !lengthMeters && !totalSeats) {
    return undefined;
  }
  return {
    contributors: swissContributors(runtime, "formation", "master-data"),
    lastUpdate: journey.lastUpdate,
    ...(lengthMeters > 0 ? { lengthMeters } : {}),
    operatorCode: evu,
    operationDate: journey.journeyMetaInformation?.operationDate,
    ...(totalSeats > 0 ? { seats: totalSeats } : {}),
    ...(shortFormation ? { shortFormation } : {}),
    source: "opentransportdata.swiss/formation",
    ...(stops.length ? { stops } : {}),
    trainNumber: journey.trainMetaInformation?.trainNumber,
    ...(vehicleCount > 0 ? { vehicleCount } : {}),
    ...(vehicles.length ? { vehicles } : {}),
  };
}

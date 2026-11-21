import type {
  Facility,
  TransitAccessibilityItem,
  TransitAmenityItem,
  TransitFareZoneSummary,
  TransitGeoJsonMultiPolygon,
  TransitGeoJsonPolygon,
  TransitPlatformDetail,
  TransitStopAreaSummary,
  TransitStopInfrastructure,
  TransitStopInfrastructureFact,
  TransitStopInfrastructureGeometry,
  TransitStopParking,
  TransitTopographicPlaceSummary,
  TransportMode,
} from "@openmapx/mobility-core/transit";
import { collectStopModes, dedupeById, isTruthyString, withEnturPrefix } from "./common.js";

interface NsrTextValue {
  lang?: string | null;
  value?: string | null;
}

interface NsrRefValue {
  ref?: string | null;
}

interface NsrRef {
  ref?: string | null;
  version?: string | null;
  created?: string | null;
  type?: string | null;
  value?: NsrRefValue | null;
}

interface NsrLocation {
  latitude?: number | null;
  longitude?: number | null;
}

interface NsrPoint {
  location?: NsrLocation | null;
}

interface NsrPosList {
  value?: number[] | null;
}

interface NsrLinearRingShape {
  posList?: NsrPosList | null;
}

interface NsrAbstractRingShape {
  type?: string | null;
  value?: NsrLinearRingShape | null;
}

interface NsrRingProperty {
  abstractRing?: NsrAbstractRingShape | null;
}

interface NsrPolygonShape {
  exterior?: NsrRingProperty | null;
  interior?: Array<NsrRingProperty | null> | null;
}

interface NsrAbstractSurfaceShape {
  type?: string | null;
  value?: NsrPolygonShape | NsrMultiSurfaceShape | null;
}

interface NsrSurfaceProperty {
  abstractSurface?: NsrAbstractSurfaceShape | null;
}

interface NsrSurfaceArray {
  abstractSurface?: Array<NsrAbstractSurfaceShape | null> | null;
}

interface NsrMultiSurfaceShape {
  surfaceMember?: Array<NsrSurfaceProperty | null> | null;
  surfaceMembers?: NsrSurfaceArray | null;
}

interface NsrPrivateCode {
  type?: string | null;
  value?: string | null;
}

interface NsrAccessibilityLimitation {
  id?: string | null;
  liftFreeAccess?: string | null;
  escalatorFreeAccess?: string | null;
  stepFreeAccess?: string | null;
  wheelchairAccess?: string | null;
  audibleSignalsAvailable?: string | null;
  visualSignsAvailable?: string | null;
}

interface NsrAccessibilityAssessment {
  limitations?: {
    accessibilityLimitation?: NsrAccessibilityLimitation | NsrAccessibilityLimitation[] | null;
  } | null;
}

interface NsrEquipmentValue {
  numberOfToilets?: number | null;
  seats?: number | null;
  numberOfMachines?: number | null;
  ticketMachines?: boolean | null;
  ticketOffice?: boolean | null;
}

interface NsrPlaceEquipmentItem {
  type?: string | null;
  value?: NsrEquipmentValue | null;
}

interface NsrBoardingPosition {
  id?: string | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  centroid?: NsrPoint | null;
}

export interface NsrParking {
  id?: string | null;
  name?: NsrTextValue | null;
  parkingVehicleTypes?: string[] | null;
  totalCapacity?: number | null;
  principalCapacity?: number | null;
  realTimeOccupancyAvailable?: boolean | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  parkingType?: string | null;
  centroid?: NsrPoint | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
}

export interface NsrStopPlaceRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  centroid?: NsrPoint | null;
  transportMode?: string | null;
  stopPlaceType?: string | null;
  weighting?: string | null;
  parentSiteRef?: NsrRef | null;
  topographicPlaceRef?: NsrRef | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
  accessibilityAssessment?: NsrAccessibilityAssessment | null;
  placeEquipments?: {
    installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null;
  } | null;
  quays?: {
    quayRefOrQuay?: Array<NsrQuayRecord | null> | null;
  } | null;
  tariffZones?: {
    tariffZoneRef?: Array<NsrRef | null> | null;
  } | null;
}

export interface NsrQuayRecord {
  id?: string | null;
  publicCode?: string | null;
  privateCode?: NsrPrivateCode | null;
  transportMode?: string | null;
  compassBearing?: number | null;
  centroid?: NsrPoint | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
  accessibilityAssessment?: NsrAccessibilityAssessment | null;
  placeEquipments?: {
    installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null;
  } | null;
  boardingPositions?: {
    boardingPositionRefOrBoardingPosition?: Array<NsrBoardingPosition | null> | null;
  } | null;
  parentQuayRef?: NsrRef | null;
}

export interface NsrFareZoneRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  transportOrganisationRef?: NsrRef | null;
  privateCode?: NsrPrivateCode | null;
  polygon?: NsrPolygonShape | null;
  multiSurface?: NsrMultiSurfaceShape | null;
}

export interface NsrTopographicPlaceRecord {
  id?: string | null;
  name?: NsrTextValue | null;
  descriptor?: {
    name?: NsrTextValue | null;
  } | null;
  topographicPlaceType?: string | null;
  parentTopographicPlaceRef?: NsrRef | null;
}

export function nsrTextValue(value: NsrTextValue | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

function nsrArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter((item): item is T => item != null);
  return value != null ? [value] : [];
}

export function nsrRefValue(value: NsrRef | null | undefined): string | undefined {
  if (isTruthyString(value?.ref)) return value.ref;
  if (isTruthyString(value?.value?.ref)) return value.value.ref;
  return undefined;
}

export function nsrPrivateCodeValue(value: NsrPrivateCode | null | undefined): string | undefined {
  return isTruthyString(value?.value) ? value.value : undefined;
}

function nsrPointLocation(point: NsrPoint | null | undefined): { lat: number; lng: number } | null {
  const latitude = point?.location?.latitude;
  const longitude = point?.location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  return { lat: latitude, lng: longitude };
}

export function ensureClosedRing(coordinates: [number, number][]): [number, number][] {
  const first = coordinates[0];
  const last = coordinates.at(-1);
  if (!first || !last) return coordinates;
  const [firstLng, firstLat] = first;
  const [lastLng, lastLat] = last;
  if (firstLng === lastLng && firstLat === lastLat) return coordinates;
  return [...coordinates, [firstLng, firstLat]];
}

export function nsrCoordinatesFromPosList(
  value: number[] | null | undefined,
): [number, number][] | null {
  if (!Array.isArray(value) || value.length < 6 || value.length % 2 !== 0) return null;
  const coordinates: [number, number][] = [];
  for (let index = 0; index < value.length; index += 2) {
    const lat = value[index];
    const lng = value[index + 1];
    if (
      typeof lat !== "number" ||
      !Number.isFinite(lat) ||
      typeof lng !== "number" ||
      !Number.isFinite(lng)
    ) {
      return null;
    }
    coordinates.push([lng, lat]);
  }
  return ensureClosedRing(coordinates);
}

function nsrRingCoordinates(ring: NsrRingProperty | null | undefined): [number, number][] | null {
  return nsrCoordinatesFromPosList(ring?.abstractRing?.value?.posList?.value);
}

function nsrPolygonGeometry(
  polygon: NsrPolygonShape | null | undefined,
): TransitGeoJsonPolygon | null {
  const exterior = nsrRingCoordinates(polygon?.exterior);
  if (!exterior) return null;
  const interior = nsrArray(polygon?.interior)
    .map((ring) => nsrRingCoordinates(ring))
    .filter((ring): ring is [number, number][] => ring !== null);
  return {
    type: "Polygon",
    coordinates: [exterior, ...interior],
  };
}

function nsrSurfaceGeometry(
  surface: NsrAbstractSurfaceShape | null | undefined,
): TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null {
  const value = surface?.value;
  if (!value) return null;
  if (surface.type === "Polygon" || "exterior" in value) {
    return nsrPolygonGeometry(value as NsrPolygonShape);
  }
  if (surface.type === "MultiSurface" || "surfaceMember" in value || "surfaceMembers" in value) {
    return nsrMultiSurfaceGeometry(value as NsrMultiSurfaceShape);
  }
  return null;
}

function nsrMultiSurfaceGeometry(
  multiSurface: NsrMultiSurfaceShape | null | undefined,
): TransitGeoJsonMultiPolygon | null {
  const members = [
    ...nsrArray(multiSurface?.surfaceMember)
      .map((member) => member?.abstractSurface ?? null)
      .filter((surface): surface is NsrAbstractSurfaceShape => surface !== null),
    ...nsrArray(multiSurface?.surfaceMembers?.abstractSurface).filter(
      (surface): surface is NsrAbstractSurfaceShape => surface !== null,
    ),
  ];
  const polygons = members.flatMap((surface) => {
    const geometry = nsrSurfaceGeometry(surface);
    if (!geometry) return [];
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  });
  return polygons.length > 0
    ? {
        type: "MultiPolygon",
        coordinates: polygons,
      }
    : null;
}

export function nsrRecordGeometry(
  polygon: NsrPolygonShape | null | undefined,
  multiSurface: NsrMultiSurfaceShape | null | undefined,
): TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null {
  return nsrPolygonGeometry(polygon) ?? nsrMultiSurfaceGeometry(multiSurface);
}

export function humanizeNsrEnum(value: string | null | undefined): string | undefined {
  if (!isTruthyString(value)) return undefined;
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatTransportModes(modes: TransportMode[]): string {
  return modes.map((mode) => humanizeNsrEnum(mode) ?? mode).join(", ");
}

export function collectNsrLimitations(
  assessment: NsrAccessibilityAssessment | null | undefined,
): NsrAccessibilityLimitation[] {
  return nsrArray(assessment?.limitations?.accessibilityLimitation);
}

export function collectNsrEquipmentItems(
  placeEquipments:
    | { installedEquipmentRefOrInstalledEquipment?: Array<NsrPlaceEquipmentItem | null> | null }
    | null
    | undefined,
): NsrPlaceEquipmentItem[] {
  return (placeEquipments?.installedEquipmentRefOrInstalledEquipment ?? []).filter(
    (item): item is NsrPlaceEquipmentItem => item != null,
  );
}

function collectNsrQuays(stopPlace: NsrStopPlaceRecord | null | undefined): NsrQuayRecord[] {
  return (stopPlace?.quays?.quayRefOrQuay ?? []).filter(
    (quay): quay is NsrQuayRecord => quay != null,
  );
}

export function collectNsrTariffZoneRefs(
  stopPlace: NsrStopPlaceRecord | null | undefined,
): string[] {
  const refs = (stopPlace?.tariffZones?.tariffZoneRef ?? [])
    .map((ref) => nsrRefValue(ref))
    .filter((ref): ref is string => isTruthyString(ref));
  return Array.from(new Set(refs));
}

export function transportModesFromStopPlace(stopPlace: NsrStopPlaceRecord): TransportMode[] {
  if (isTruthyString(stopPlace.transportMode)) {
    return collectStopModes([stopPlace.transportMode]);
  }
  return collectStopModes(collectNsrQuays(stopPlace).map((quay) => quay.transportMode ?? null));
}

function firstKnownStopLocation(
  stopPlace: NsrStopPlaceRecord | null | undefined,
): { lat: number; lng: number } | null {
  const centroid = nsrPointLocation(stopPlace?.centroid);
  if (centroid) return centroid;
  for (const quay of collectNsrQuays(stopPlace)) {
    const quayPoint = nsrPointLocation(quay.centroid);
    if (quayPoint) return quayPoint;
  }
  return null;
}

export function normalizeNsrStopAreaSummary(
  stopPlace: NsrStopPlaceRecord | null | undefined,
  level: TransitStopAreaSummary["level"],
  options?: {
    modes?: TransportMode[];
    parentStopId?: string;
  },
): TransitStopAreaSummary | null {
  if (!isTruthyString(stopPlace?.id) || !isTruthyString(nsrTextValue(stopPlace?.name))) return null;
  const location = firstKnownStopLocation(stopPlace);
  if (!location) return null;
  const modes = options?.modes?.length ? options.modes : transportModesFromStopPlace(stopPlace);
  return {
    id: withEnturPrefix(stopPlace.id),
    name: nsrTextValue(stopPlace.name) as string,
    lat: location.lat,
    lng: location.lng,
    modes,
    level,
    stopType: stopPlace.stopPlaceType ?? undefined,
    weighting: stopPlace.weighting ?? undefined,
    parentStopId: options?.parentStopId,
  };
}

export function normalizePlatformSummary(platform: TransitPlatformDetail): TransitStopAreaSummary {
  return {
    id: platform.id,
    name: platform.publicCode ? `Platform ${platform.publicCode}` : platform.name,
    lat: platform.lat,
    lng: platform.lng,
    modes: platform.modes,
    level: "platform",
    parentStopId: platform.parentStopId,
  };
}

export function mergeAccessibilityItems(
  items: TransitAccessibilityItem[],
): TransitAccessibilityItem[] {
  const merged = new Map<string, TransitAccessibilityItem>();
  for (const item of items) {
    const existing = merged.get(item.category);
    if (!existing) {
      merged.set(item.category, item);
      continue;
    }
    if (item.available && !existing.available) {
      merged.set(item.category, item);
    }
  }
  return Array.from(merged.values());
}

export function mapNsrAccessibility(
  sourceId: string,
  limitations: NsrAccessibilityLimitation[],
): TransitAccessibilityItem[] {
  const definitions: Array<{
    key: keyof NsrAccessibilityLimitation;
    category: TransitAccessibilityItem["category"];
    label: string;
  }> = [
    { key: "stepFreeAccess", category: "step_free", label: "Step-free access" },
    { key: "wheelchairAccess", category: "wheelchair", label: "Wheelchair access" },
    { key: "liftFreeAccess", category: "elevator", label: "Elevator access" },
    { key: "escalatorFreeAccess", category: "escalator", label: "Escalator access" },
    { key: "visualSignsAvailable", category: "visual", label: "Visual signage" },
    { key: "audibleSignalsAvailable", category: "audible", label: "Audible signals" },
  ];
  return definitions
    .map((definition) => {
      const values = limitations
        .map((item) => item[definition.key])
        .filter((value): value is string => isTruthyString(value));
      if (values.some((value) => value === "TRUE")) {
        return {
          id: `${sourceId}:${definition.category}`,
          category: definition.category,
          label: definition.label,
          available: true,
        } satisfies TransitAccessibilityItem;
      }
      if (values.some((value) => value === "FALSE")) {
        return {
          id: `${sourceId}:${definition.category}`,
          category: definition.category,
          label: definition.label,
          available: false,
        } satisfies TransitAccessibilityItem;
      }
      return null;
    })
    .filter((item): item is TransitAccessibilityItem => item !== null);
}

function amenityFromEquipment(
  sourceId: string,
  item: NsrPlaceEquipmentItem,
): TransitAmenityItem | null {
  if (!isTruthyString(item.type)) return null;
  const normalized = item.type.toLowerCase();
  if (normalized === "waitingroomequipment") {
    return {
      id: `${sourceId}:waiting-room`,
      category: "waiting_room",
      label: "Waiting room",
      count:
        typeof item.value?.seats === "number" && Number.isFinite(item.value.seats)
          ? item.value.seats
          : undefined,
    };
  }
  if (normalized === "ticketingequipment") {
    return {
      id: `${sourceId}:ticketing`,
      category: "ticketing",
      label: "Ticketing",
      count:
        typeof item.value?.numberOfMachines === "number" &&
        Number.isFinite(item.value.numberOfMachines)
          ? item.value.numberOfMachines
          : undefined,
    };
  }
  if (normalized === "sanitaryequipment") {
    return {
      id: `${sourceId}:toilets`,
      category: "toilets",
      label: "Toilets",
      count:
        typeof item.value?.numberOfToilets === "number" &&
        Number.isFinite(item.value.numberOfToilets)
          ? item.value.numberOfToilets
          : undefined,
    };
  }
  if (normalized.includes("bicycle") || normalized.includes("cycle")) {
    return {
      id: `${sourceId}:bike-storage:${item.type}`,
      category: "bike_storage",
      label: "Bike storage",
    };
  }
  return {
    id: `${sourceId}:equipment:${item.type}`,
    category: "other",
    label: item.type.replace(/([a-z])([A-Z])/g, "$1 $2"),
  };
}

export function mergeAmenityItems(items: TransitAmenityItem[]): TransitAmenityItem[] {
  const merged = new Map<string, TransitAmenityItem>();
  for (const item of items) {
    const key = `${item.category}:${item.label}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    merged.set(key, {
      ...existing,
      count:
        typeof existing.count === "number" || typeof item.count === "number"
          ? (existing.count ?? 0) + (item.count ?? 0)
          : undefined,
    });
  }
  return Array.from(merged.values());
}

export function mapNsrAmenities(
  sourceId: string,
  equipmentItems: NsrPlaceEquipmentItem[],
): TransitAmenityItem[] {
  return mergeAmenityItems(
    equipmentItems
      .map((item) => amenityFromEquipment(sourceId, item))
      .filter((item): item is TransitAmenityItem => item !== null),
  );
}

export function normalizeNsrPlatformDetail(
  quay: NsrQuayRecord,
  parentStop: NsrStopPlaceRecord,
  modes: TransportMode[],
): TransitPlatformDetail | null {
  if (!isTruthyString(quay.id)) return null;
  const quayLocation = nsrPointLocation(quay.centroid) ?? firstKnownStopLocation(parentStop);
  if (!quayLocation || !isTruthyString(parentStop.id)) return null;
  const accessibilityLabels = mapNsrAccessibility(
    withEnturPrefix(quay.id),
    collectNsrLimitations(quay.accessibilityAssessment),
  )
    .filter((item) => item.available)
    .map((item) => item.label);
  const amenityLabels = mapNsrAmenities(
    withEnturPrefix(quay.id),
    collectNsrEquipmentItems(quay.placeEquipments),
  ).map((item) => item.label);
  const boardingPositions = nsrArray(quay.boardingPositions?.boardingPositionRefOrBoardingPosition)
    .filter((position): position is NsrBoardingPosition => position != null)
    .map(
      (position) =>
        position.publicCode ?? nsrPrivateCodeValue(position.privateCode) ?? position.id ?? "",
    )
    .filter((value) => value.length > 0);
  return {
    id: withEnturPrefix(quay.id),
    name: nsrTextValue(parentStop.name) ?? quay.publicCode ?? quay.id,
    lat: quayLocation.lat,
    lng: quayLocation.lng,
    modes,
    parentStopId: withEnturPrefix(parentStop.id),
    publicCode: quay.publicCode ?? undefined,
    privateCode: nsrPrivateCodeValue(quay.privateCode),
    bearing: typeof quay.compassBearing === "number" ? quay.compassBearing : undefined,
    boardingPositions: boardingPositions.length > 0 ? boardingPositions : undefined,
    accessibilityLabels: accessibilityLabels.length > 0 ? accessibilityLabels : undefined,
    amenityLabels: amenityLabels.length > 0 ? amenityLabels : undefined,
  };
}

export function mergePlatformDetails(items: TransitPlatformDetail[]): TransitPlatformDetail[] {
  const merged = new Map<string, TransitPlatformDetail>();
  for (const item of items) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
      continue;
    }
    const existing = merged.get(item.id) as TransitPlatformDetail;
    merged.set(item.id, {
      ...existing,
      publicCode: existing.publicCode ?? item.publicCode,
      privateCode: existing.privateCode ?? item.privateCode,
      bearing: existing.bearing ?? item.bearing,
      boardingPositions:
        existing.boardingPositions?.length || item.boardingPositions?.length
          ? Array.from(
              new Set([...(existing.boardingPositions ?? []), ...(item.boardingPositions ?? [])]),
            )
          : undefined,
      accessibilityLabels:
        existing.accessibilityLabels?.length || item.accessibilityLabels?.length
          ? Array.from(
              new Set([
                ...(existing.accessibilityLabels ?? []),
                ...(item.accessibilityLabels ?? []),
              ]),
            )
          : undefined,
      amenityLabels:
        existing.amenityLabels?.length || item.amenityLabels?.length
          ? Array.from(new Set([...(existing.amenityLabels ?? []), ...(item.amenityLabels ?? [])]))
          : undefined,
    });
  }
  return Array.from(merged.values());
}

export function parkingKindFromVehicleTypes(
  vehicleTypes: string[],
  parkingType?: string | null,
): TransitStopParking["kind"] {
  const normalizedParkingType = parkingType?.toUpperCase();
  if (
    normalizedParkingType === "PARK_AND_RIDE" ||
    normalizedParkingType === "TRAIN_STATION_PARKING"
  ) {
    return "park_and_ride";
  }

  const normalized = new Set(vehicleTypes.map((value) => value.toUpperCase()));
  if (normalized.has("PEDAL_CYCLE") || normalized.has("BICYCLE")) return "bike_parking";
  if (
    normalized.has("CAR") ||
    normalized.has("PASSENGER_CAR") ||
    normalized.has("AUTOMOBILE") ||
    normalized.has("MOTOR_VEHICLE")
  ) {
    return "park_and_ride";
  }
  return normalized.size > 0 ? "parking" : "other";
}

export function mapNsrParking(parking: NsrParking): TransitStopParking | null {
  if (!isTruthyString(parking.id)) return null;
  const location = nsrPointLocation(parking.centroid);
  if (!location) return null;
  const vehicleTypes = parking.parkingVehicleTypes ?? [];
  return {
    id: parking.id,
    name: nsrTextValue(parking.name) ?? "Parking",
    lat: location.lat,
    lng: location.lng,
    kind: parkingKindFromVehicleTypes(vehicleTypes, parking.parkingType),
    vehicleTypes,
    capacity:
      typeof parking.totalCapacity === "number"
        ? parking.totalCapacity
        : typeof parking.principalCapacity === "number"
          ? parking.principalCapacity
          : undefined,
    hasRealtimeData: parking.realTimeOccupancyAvailable ?? undefined,
  };
}

export function mapNsrFareZone(
  fareZone: NsrFareZoneRecord,
  fallbackId?: string,
): TransitFareZoneSummary | null {
  const id = fareZone.id ?? fallbackId;
  if (!isTruthyString(id)) return null;
  const authorityId = nsrRefValue(fareZone.transportOrganisationRef);
  return {
    id,
    name: nsrTextValue(fareZone.name) ?? id,
    authorityId,
    authorityName: authorityId?.split(":").at(-1),
    privateCode: nsrPrivateCodeValue(fareZone.privateCode),
    hasGeometry: Boolean(fareZone.polygon ?? fareZone.multiSurface),
    isDeprecatedTariffZone: id.includes(":TariffZone:"),
  };
}

export function mapNsrTopographicPlace(
  topographicPlace: NsrTopographicPlaceRecord,
): TransitTopographicPlaceSummary | null {
  if (!isTruthyString(topographicPlace.id)) return null;
  const name =
    nsrTextValue(topographicPlace.name) ??
    nsrTextValue(topographicPlace.descriptor?.name) ??
    topographicPlace.id;
  return {
    id: topographicPlace.id,
    name,
    placeType: topographicPlace.topographicPlaceType ?? undefined,
    parentTopographicPlaceId: nsrRefValue(topographicPlace.parentTopographicPlaceRef),
  };
}

export function buildStopInfrastructureFacts(input: {
  requestedStop: TransitStopAreaSummary;
  canonicalStop: TransitStopAreaSummary;
  parentStop?: TransitStopAreaSummary;
  childStops: TransitStopAreaSummary[];
  platforms: TransitPlatformDetail[];
  fareZones: TransitFareZoneSummary[];
  parking: TransitStopParking[];
  topographicPlace?: TransitTopographicPlaceSummary;
}): TransitStopInfrastructureFact[] {
  const facts: TransitStopInfrastructureFact[] = [];
  if (input.canonicalStop.stopType) {
    facts.push({
      label: "Stop type",
      value: humanizeNsrEnum(input.canonicalStop.stopType) ?? input.canonicalStop.stopType,
    });
  }
  if (input.canonicalStop.weighting) {
    facts.push({
      label: "Weighting",
      value: humanizeNsrEnum(input.canonicalStop.weighting) ?? input.canonicalStop.weighting,
    });
  }
  if (input.canonicalStop.modes.length > 0) {
    facts.push({
      label: "Transport modes",
      value: formatTransportModes(input.canonicalStop.modes),
    });
  }
  if (input.parentStop) {
    facts.push({ label: "Parent station", value: input.parentStop.name });
  }
  if (input.topographicPlace) {
    facts.push({
      label: "Topographic place",
      value: input.topographicPlace.name,
    });
  }
  if (input.childStops.length > 0) {
    facts.push({ label: "Child stop areas", value: String(input.childStops.length) });
  }
  if (input.platforms.length > 0) {
    facts.push({ label: "Platforms", value: String(input.platforms.length) });
  }
  if (input.fareZones.length > 0) {
    facts.push({ label: "Fare zones", value: String(input.fareZones.length) });
  }
  if (input.parking.length > 0) {
    facts.push({ label: "Attached parking", value: String(input.parking.length) });
  }
  if (input.requestedStop.level === "platform") {
    facts.push({ label: "Focused object", value: "Platform" });
  }
  return facts;
}

export function facilitiesFromStopInfrastructure(
  infrastructure: Pick<
    TransitStopInfrastructure,
    "stopId" | "accessibility" | "amenities" | "parking"
  >,
): Facility[] {
  const stopId = infrastructure.stopId;
  const facilities: Facility[] = [];
  for (const item of infrastructure.accessibility) {
    if (!item.available) continue;
    const type =
      item.category === "elevator"
        ? "elevator"
        : item.category === "escalator"
          ? "escalator"
          : item.category === "step_free"
            ? "other"
            : null;
    if (type === null) continue;
    facilities.push({
      id: `${stopId}:accessibility:${item.category}`,
      stopId,
      name: item.label,
      type,
      isAccessible: item.available,
      provider: "entur",
    });
  }
  for (const item of infrastructure.amenities) {
    const type =
      item.category === "bike_storage"
        ? "bike_storage"
        : item.category === "parking"
          ? "parking"
          : "other";
    facilities.push({
      id: `${stopId}:amenity:${item.category}:${item.label}`,
      stopId,
      name: item.label,
      type,
      isAccessible: true,
      provider: "entur",
    });
  }
  for (const item of infrastructure.parking) {
    facilities.push({
      id: item.id,
      stopId,
      name: item.name,
      type: item.kind === "bike_parking" ? "bike_storage" : "parking",
      isAccessible: true,
      provider: "entur",
    });
  }
  return dedupeById(facilities);
}

export function facilitiesFromParkings(stopId: string, parkings: NsrParking[]): Facility[] {
  return parkings
    .filter((parking) => isTruthyString(parking.id))
    .map((parking) => {
      const vehicleTypes = new Set(
        (parking.parkingVehicleTypes ?? []).map((value) => value.toUpperCase()),
      );
      const type =
        vehicleTypes.has("PEDAL_CYCLE") || vehicleTypes.has("BICYCLE") ? "bike_storage" : "parking";
      return {
        id: parking.id as string,
        stopId,
        name: nsrTextValue(parking.name) ?? (type === "bike_storage" ? "Bike parking" : "Parking"),
        type,
        isAccessible: true,
        provider: "entur",
      } satisfies Facility;
    });
}

function sortStopAreas(items: TransitStopAreaSummary[]): TransitStopAreaSummary[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function sortPlatforms(items: TransitPlatformDetail[]): TransitPlatformDetail[] {
  return [...items].sort(
    (a, b) =>
      a.parentStopId.localeCompare(b.parentStopId) ||
      (a.publicCode ?? a.privateCode ?? a.name).localeCompare(
        b.publicCode ?? b.privateCode ?? b.name,
        undefined,
        { numeric: true },
      ),
  );
}

function uniqueStopAreas(items: TransitStopAreaSummary[]): TransitStopAreaSummary[] {
  return sortStopAreas(dedupeById(items));
}

export function uniqueParking(items: TransitStopParking[]): TransitStopParking[] {
  return dedupeById(items).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function uniqueFareZones(items: TransitFareZoneSummary[]): TransitFareZoneSummary[] {
  return dedupeById(items).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function uniqueFareZoneGeometries(
  items: NonNullable<TransitStopInfrastructureGeometry["fareZones"]>,
): NonNullable<TransitStopInfrastructureGeometry["fareZones"]> {
  const unique = new Map<
    string,
    NonNullable<TransitStopInfrastructureGeometry["fareZones"]>[number]
  >();
  for (const item of items) {
    if (!unique.has(item.fareZoneId)) unique.set(item.fareZoneId, item);
  }
  return Array.from(unique.values()).sort((a, b) => a.fareZoneId.localeCompare(b.fareZoneId));
}

export function buildStopInfrastructureGeometry(input: {
  stopArea?: TransitGeoJsonPolygon | TransitGeoJsonMultiPolygon | null;
  fareZoneGeometries?: NonNullable<TransitStopInfrastructureGeometry["fareZones"]>;
}): TransitStopInfrastructureGeometry | undefined {
  const stopArea = input.stopArea ?? undefined;
  const fareZones = input.fareZoneGeometries?.length ? input.fareZoneGeometries : undefined;
  if (!stopArea && !fareZones) return undefined;
  return {
    stopArea,
    fareZones,
  };
}

export function collectPlatformsForStopPlaces(
  stopPlaces: NsrStopPlaceRecord[],
): TransitPlatformDetail[] {
  const platforms = stopPlaces.flatMap((stopPlace) => {
    const modes = transportModesFromStopPlace(stopPlace);
    return collectNsrQuays(stopPlace)
      .map((quay) => normalizeNsrPlatformDetail(quay, stopPlace, modes))
      .filter((platform): platform is TransitPlatformDetail => platform !== null);
  });
  return sortPlatforms(mergePlatformDetails(platforms));
}

export function mergeStopInfrastructureItems(stopPlaces: NsrStopPlaceRecord[]): {
  accessibility: TransitAccessibilityItem[];
  amenities: TransitAmenityItem[];
} {
  const accessibility = mergeAccessibilityItems(
    stopPlaces.flatMap((stopPlace) =>
      mapNsrAccessibility(
        withEnturPrefix(stopPlace.id ?? "unknown"),
        collectNsrLimitations(stopPlace.accessibilityAssessment),
      ),
    ),
  );
  const amenities = mergeAmenityItems(
    stopPlaces.flatMap((stopPlace) =>
      mapNsrAmenities(
        withEnturPrefix(stopPlace.id ?? "unknown"),
        collectNsrEquipmentItems(stopPlace.placeEquipments),
      ),
    ),
  );
  return { accessibility, amenities };
}

export function buildSiblingStops(
  children: NsrStopPlaceRecord[],
  currentStopId: string,
): TransitStopAreaSummary[] {
  return uniqueStopAreas(
    children
      .filter((child) => child.id !== currentStopId)
      .map((child) =>
        normalizeNsrStopAreaSummary(child, "child_stop", {
          parentStopId: nsrRefValue(child.parentSiteRef)
            ? withEnturPrefix(nsrRefValue(child.parentSiteRef) as string)
            : undefined,
        }),
      )
      .filter((child): child is TransitStopAreaSummary => child !== null),
  );
}

export function buildChildStopAreas(
  parentStopId: string,
  children: NsrStopPlaceRecord[],
): TransitStopAreaSummary[] {
  return uniqueStopAreas(
    children
      .map((child) =>
        normalizeNsrStopAreaSummary(child, "child_stop", {
          parentStopId: withEnturPrefix(parentStopId),
        }),
      )
      .filter((child): child is TransitStopAreaSummary => child !== null),
  );
}

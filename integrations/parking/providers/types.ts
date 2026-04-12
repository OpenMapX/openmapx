export type ParkingType = "garage" | "surface" | "underground" | "on-street" | "unknown";

export interface ParkingFacility {
  id: string;
  name: string;
  coordinates: [number, number]; // [lng, lat]
  sources: string[];

  parkingType: ParkingType;

  capacity?: number;
  freeSpaces?: number;
  hasRealtimeData: boolean;

  disabledSpaces?: number;
  chargingSpaces?: number;
  maxHeight?: number; // centimeters

  fee?: "free" | "paid" | "unknown";
  feeDescription?: string;
  /** Structured pricing rows: [durationLabel, formattedPrice] */
  tariffRows?: [string, string][];
  access?: "public" | "customers" | "private" | "permit";

  operator?: string;
  address?: string;

  openingHours?: string;
  state?: "open" | "closed" | "unknown";

  parkAndRide?: boolean;
  nearestStation?: string;
  chargingDetails?: string;
  paymentMethods?: string;
  url?: string;
}

/** Raw response shape from the ParkenDD v2 root endpoint. */
export interface ParkApiV2City {
  name: string;
  coords: { lat: number; lng: number };
  url: string;
  source?: string;
  attribution?: { contributor: string; url: string; license?: string };
  active_support: boolean;
}

/** Raw lot shape from the ParkenDD v2 per-city endpoint. */
export interface ParkApiV2Lot {
  id: string;
  name: string;
  address?: string;
  coords?: { lat: number; lng: number };
  total?: number;
  free?: number;
  lot_type?: string;
  state?: string;
  forecast?: boolean;
  region?: string;
}

/** Raw parking site from ParkAPI v3 (MobiData BW). */
export interface ParkApiV3Site {
  id: number;
  original_uid?: string;
  name: string;
  address?: string;
  lat?: string;
  lon?: string;
  capacity?: number;
  realtime_free_capacity?: number | null;
  realtime_capacity?: number | null;
  type?: string;
  purpose?: string;
  has_realtime_data?: boolean;
  has_fee?: boolean;
  fee_description?: string;
  opening_hours?: string;
  operator_name?: string;
  public_url?: string;
  capacity_disabled?: number | null;
  capacity_charging?: number | null;
  capacity_woman?: number | null;
  max_height?: number | null;
  source_uid?: string;
}

/** Raw record from RDW Socrata GEO parking datasets (t5pc-eb34, 6wzd-evwu, 9c54-cmfx). */
export interface RdwGeoRecord {
  areamanagerid: string;
  areaid: string;
  areadesc: string;
  location: { latitude: string; longitude: string };
  startdataarea?: string;
  enddataarea?: string;
  usageid: string;
  /** Carpool-specific: number of parking spaces. */
  aantal_parkeer_plaatsen?: string;
  /** Carpool-specific: number of charging points. */
  aantal_laad_punten?: string;
  /** Carpool-specific: accessible for disabled ("Ja"/"Nee"). */
  toegankelijk_voor_gehandicapten?: string;
  /** Carpool-specific: maximum entry height. */
  maximale_inrij_hoogte?: string;
}

/** Raw record from RDW Socrata SPECIFICATIES PARKEERGEBIED (b3us-f26s). */
export interface RdwSpecsRecord {
  areamanagerid: string;
  areaid: string;
  capacity?: string;
  chargingpointcapacity?: string;
  disabledaccess?: string;
  maximumvehicleheight?: string;
  limitedaccess?: string;
}

/** Raw properties from BNLS France Opendatasoft record. */
export interface BnlsFrRecord {
  id: string;
  name: string | null;
  geo_point_2d?: { lon: number; lat: number };
  xlong?: number;
  ylat?: number;
  space_count?: number | null;
  is_free?: number | null;
  facilities_type?: string | null;
  cost_1h?: number | null;
  cost_2h?: number | null;
  cost_3h?: number | null;
  cost_4h?: number | null;
  cost_24h?: number | null;
  resident_sub?: number | null;
  non_resident_sub?: number | null;
  disable_count?: number | null;
  electric_car_count?: number | null;
  park_ride_count?: number | null;
  max_height?: number | null;
  address?: string | null;
  url?: string | null;
  com_name?: string | null;
  user_type?: string | null;
  info?: string | null;
}

/** Raw facility from DB BahnPark Parking Information API v2. */
export interface DbBahnParkFacility {
  id: string;
  name: { name: string; context: string }[];
  url?: string;
  type?: { name?: string; nameEn?: string };
  operator?: { name?: string; url?: string };
  address?: {
    streetAndNumber?: string;
    zip?: string;
    city?: string;
    phone?: string | null;
    location?: { latitude: number; longitude: number };
  };
  station?: {
    stationId?: { identifier?: string };
    name?: string;
    distance?: string;
  };
  capacity?: { type: string; total: string }[];
  hasPrognosis?: boolean;
  access?: {
    outOfService?: { isOutOfService: boolean };
    openingHours?: { text?: string; textEn?: string; is24h?: boolean };
    restrictions?: {
      clearance?: { height?: string | null; width?: string | null };
    };
  };
  equipment?: {
    charging?: { hasChargingStation?: boolean; details?: string };
  };
  tariff?: {
    information?: {
      dynamic?: {
        tariffPaymentOptions?: string;
        tariffMaxParkingTime?: string;
      };
    };
    prices?: {
      group?: { groupName?: string };
      duration?: string;
      price?: number | null;
    }[];
  };
}

/** Raw parking item from the Autobahn API (verkehr.autobahn.de). */
export interface AutobahnParkingLorry {
  identifier: string;
  isBlocked: string;
  future: boolean;
  subtitle: string;
  title: string;
  coordinate: { long: string; lat: string };
  description: string[];
  lorryParkingFeatureIcons: Array<{
    icon: string;
    description: string;
    style: string;
  }>;
}

/** Raw station record from Open Data Hub ParkingStation endpoint. */
export interface OdhParkingStation {
  scode: string;
  sname: string;
  scoordinate: { x: number; y: number; srid: number };
  smetadata: Record<string, unknown> & {
    capacity?: number;
    municipality?: string;
    standard_name?: string;
    netex_parking?: {
      type?: string;
      layout?: string;
      charging?: boolean;
    };
  };
}

/** Raw measurement from Open Data Hub latest endpoint. */
export interface OdhParkingMeasurement {
  scode: string;
  tname: string;
  mvalue: number;
  mvalidtime: string;
}

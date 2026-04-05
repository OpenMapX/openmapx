export type ParkingType = "garage" | "surface" | "underground" | "on-street" | "unknown";

export interface ParkingAttribution {
  label: string;
  url: string;
  license?: string;
  licenseUrl?: string;
}

export interface ParkingFacility {
  id: string;
  name: string;
  coordinates: [number, number]; // [lng, lat]
  source: string;

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

  attribution: ParkingAttribution | ParkingAttribution[];
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

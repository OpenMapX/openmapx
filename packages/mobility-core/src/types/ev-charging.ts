import type { BoundingBox, DataSourceAttribution } from "@openmapx/core";

export type EvChargingStatus = "operational" | "not-operational" | "planned" | "unknown";

export interface EvChargingAddress {
  line1?: string;
  town?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface EvChargingConnector {
  type?: string;
  powerKw?: number;
  currentType?: string;
  quantity?: number;
  status?: string;
  reference?: string;
}

export interface EvChargingOperator {
  name: string;
  url?: string;
  legalName?: string;
}

export interface EvChargingStation {
  id: string;
  name: string;
  coordinates: [number, number];
  sources: string[];
  /** Source-native ids that belong to this merged station. Used for cache/detail matching. */
  sourceItemIds?: string[];
  attributions?: DataSourceAttribution[];

  address?: EvChargingAddress;
  operator?: EvChargingOperator;
  status?: EvChargingStatus;

  usageType?: string;
  usageCost?: string;
  membershipRequired?: boolean;
  openingHours?: string;
  access?: string;
  paymentMethods?: string[];

  connectors: EvChargingConnector[];
  updatedAt?: string;
  sourceUrl?: string;
  notes?: string[];
  osmTags?: Record<string, string>;
}

export interface EvChargingSource {
  readonly id: string;
  readonly priority: number;
  search(bbox: BoundingBox, filters?: Record<string, unknown>): Promise<EvChargingStation[]>;
  canFetchDetail?: (itemId: string) => boolean;
  fetchDetail?: (itemId: string) => Promise<EvChargingStation | null>;
}

import type { SearchResult } from "@openmapx/core";
import type { SavedPlaceFieldContributors } from "@openmapx/core/saved-place-contributors";

export const SAVED_IMPORT_ACCEPT = ".zip,.csv,.json,.geojson,.gpx,.kml,.kmz";

export type ImportStatus = "exact" | "approximate" | "needsLookup" | "located" | "unresolved";
export interface ImportPlace {
  name: string;
  address?: string;
  note?: string;
  lat?: number;
  lng?: number;
  status: ImportStatus;
  geocoder?: SearchResult;
  fieldContributors?: SavedPlaceFieldContributors;
}
export interface ImportList {
  name: string;
  source: string;
  systemList?: "$favorites" | "$wantToGo" | "$starredPlaces";
  places: ImportPlace[];
}
export type ImportErrorCode = "unsupported" | "malformed" | "empty" | "networkLink" | "tooLarge";
export interface ParsedImport {
  lists: ImportList[];
  errors: { file: string; code: ImportErrorCode }[];
}
export interface ParseOptions {
  droppedPin?: string;
  tagsLabel?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}
export class ImportFileError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
export function truncate(value: string, limit: number): string {
  const result = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}
export function validCoordinates(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    (lat !== 0 || lng !== 0)
  );
}
export function makePlace(input: ImportPlace): ImportPlace {
  return {
    ...input,
    name: truncate(input.name.trim(), 500),
    address: input.address ? truncate(input.address, 500) : undefined,
    note: input.note ? truncate(input.note, 2000) : undefined,
  };
}
export function fileList(name: string, places: ImportPlace[], source: string): ImportList {
  const base =
    name
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") || name;
  const normalized = base.toLowerCase();
  const systemList =
    normalized === "want to go"
      ? "$wantToGo"
      : ["favourite places", "favorite places"].includes(normalized)
        ? "$favorites"
        : ["starred places", "saved places"].includes(normalized)
          ? "$starredPlaces"
          : undefined;
  return { name: truncate(base, 200), places, source, systemList };
}

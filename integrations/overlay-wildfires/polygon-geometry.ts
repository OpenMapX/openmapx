import { isRecord } from "./normalization.js";

export type WildfirePolygonGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function isPosition(value: unknown): value is GeoJSON.Position {
  if (!Array.isArray(value) || value.length < 2) return false;
  if (!value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
    return false;
  }
  return value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

function positionsEqual(first: GeoJSON.Position, second: GeoJSON.Position): boolean {
  return (
    first.length === second.length &&
    first.every((coordinate, index) => coordinate === second[index])
  );
}

function isLinearRing(value: unknown): value is GeoJSON.Position[] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(isPosition) &&
    positionsEqual(value[0], value[value.length - 1])
  );
}

function isPolygonCoordinates(value: unknown): value is GeoJSON.Position[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isLinearRing);
}

function isMultiPolygonCoordinates(value: unknown): value is GeoJSON.Position[][][] {
  return Array.isArray(value) && value.length > 0 && value.every(isPolygonCoordinates);
}

export function isWildfirePolygonGeometry(value: unknown): value is WildfirePolygonGeometry {
  if (!isRecord(value)) return false;
  if (value.type === "Polygon") return isPolygonCoordinates(value.coordinates);
  if (value.type === "MultiPolygon") return isMultiPolygonCoordinates(value.coordinates);
  return false;
}

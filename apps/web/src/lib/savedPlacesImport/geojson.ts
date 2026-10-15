import { addressFromGoogleUrl, coordinatesFromGoogleUrl, nameFromGoogleUrl } from "./googleUrl";
import {
  fileList,
  type ImportList,
  makePlace,
  type ParseOptions,
  record,
  text,
  validCoordinates,
} from "./types";

export function isSavedPlacesJson(input: unknown): boolean {
  const features = record(input).features;
  return (
    Array.isArray(features) &&
    features.some((f) => {
      const p = record(record(f).properties);
      return typeof p.google_maps_url === "string" || typeof p["Google Maps URL"] === "string";
    })
  );
}
export function parseGeojson(
  input: unknown,
  filename: string,
  options: ParseOptions = {},
): ImportList[] {
  const root = record(input);
  const features = Array.isArray(root.features)
    ? root.features
    : root.type === "Feature"
      ? [root]
      : root.type === "Point"
        ? [{ geometry: root }]
        : [];
  const saved = isSavedPlacesJson(input);
  const places = features.flatMap((f) => {
    const feature = record(f);
    const p = record(feature.properties);
    if ("five_star_rating_published" in p || "Star Rating" in p) return [];
    const url = text(p.google_maps_url) || text(p["Google Maps URL"]);
    const location = record(p.location ?? p.Location);
    const geo = record(location["Geo Coordinates"] ?? location);
    const g = record(feature.geometry);
    const pair = g.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates : [];
    let lat = typeof pair[1] === "number" ? pair[1] : NaN;
    let lng = typeof pair[0] === "number" ? pair[0] : NaN;
    if (!validCoordinates(lat, lng) && saved) {
      lat = typeof geo.Latitude === "number" || text(geo.Latitude) ? Number(geo.Latitude) : NaN;
      lng = typeof geo.Longitude === "number" || text(geo.Longitude) ? Number(geo.Longitude) : NaN;
    }
    if (!saved && g.type !== "Point") return [];
    const coords = validCoordinates(lat, lng)
      ? { lat, lng, status: "exact" as const }
      : saved
        ? coordinatesFromGoogleUrl(url)
        : undefined;
    if (!coords) return [];
    const address =
      text(location.address) ||
      text(location.Address) ||
      text(p.address) ||
      addressFromGoogleUrl(url);
    const name =
      text(location.name) ||
      text(p.Title) ||
      text(location["Business Name"]) ||
      text(p.name) ||
      text(p.title) ||
      text(p.label) ||
      address ||
      nameFromGoogleUrl(url) ||
      (coords.status !== "needsLookup" ? options.droppedPin || "Dropped pin" : "");
    if (!name) return [];
    const comment = text(p.Comment);
    const note =
      text(p.note) ||
      text(p.description) ||
      (comment === "No location information is available for this saved place" ? "" : comment);
    return [makePlace({ name, address, note, ...coords })];
  });
  const list = fileList(filename, places, filename);
  if (saved) list.systemList = "$starredPlaces";
  return [list];
}

import {
  type AutocompleteResult,
  createPlace,
  type Place,
  resolvePoiIconPath,
  type SearchResult,
} from "@openmapx/core";
import {
  type EnturGeocoderFeature,
  type EnturGeocoderSources,
  EnturRequestError,
  geocoderFeatureCoordinates,
  geocoderFeatureIdentity,
  geocoderFeatureModes,
} from "@openmapx/entur-client";
import type { TransitStop } from "@openmapx/mobility-core/transit";

const STOP_TYPE_PRIORITY = [
  "railStation",
  "metroStation",
  "tramStation",
  "onstreetTram",
  "busStation",
  "coachStation",
  "onstreetBus",
  "ferryPort",
  "ferryStop",
  "harbourPort",
  "airport",
  "liftStation",
  "vehicleRailInterchange",
];
function isStop(feature: EnturGeocoderFeature): boolean {
  return feature.properties.layer === "stopPlace";
}
function type(feature: EnturGeocoderFeature): SearchResult["type"] {
  const layer = feature.properties.layer;
  return layer === "address"
    ? "address"
    : layer === "street"
      ? "street"
      : layer === "place"
        ? "region"
        : "poi";
}
function category(feature: EnturGeocoderFeature): string | undefined {
  const p = feature.properties;
  if (isStop(feature))
    return (
      STOP_TYPE_PRIORITY.find((type) => p.stopPlaceTypes?.includes(type)) ?? p.stopPlaceTypes?.[0]
    );
  return p.categories?.find((value) => value !== "poi") ?? p.categories?.[0];
}
export function featureCity(feature: EnturGeocoderFeature): string | undefined {
  const address = feature.properties.address;
  return [...new Set([address?.locality, address?.county].filter(Boolean))].join(", ") || undefined;
}
function description(feature: EnturGeocoderFeature, lang?: string): string | undefined {
  const values = feature.properties.description;
  if (!values) return undefined;
  const key = (lang ?? "").toLowerCase();
  const preferred =
    key === "en"
      ? ["eng", "en"]
      : ["no", "nb", "nn"].includes(key)
        ? ["nor", "nob", "nno", "no"]
        : [key];
  return (
    preferred.map((key) => values[key]).find((value) => value?.trim()) ??
    Object.values(values).find((value) => value.trim())
  );
}
export function createEnturProjections(sources: EnturGeocoderSources) {
  function common(feature: EnturGeocoderFeature) {
    const identity = geocoderFeatureIdentity(feature);
    const contributors = sources.contributorsFor(feature);
    const coordinates = geocoderFeatureCoordinates(feature);
    if (!coordinates) throw new EnturRequestError("response");
    return {
      id: `${identity.primaryScheme}:${identity.ids[identity.primaryScheme]}`,
      ids: identity.ids,
      coordinates,
      contributors,
      rawCategory: category(feature),
    };
  }
  return {
    search(feature: EnturGeocoderFeature): SearchResult {
      return {
        ...common(feature),
        label: feature.properties.names.display,
        name: feature.properties.names.default,
        type: type(feature),
        confidence: 1,
      };
    },
    autocomplete(feature: EnturGeocoderFeature, lang?: string): AutocompleteResult {
      const base = common(feature);
      const name = feature.properties.names.default;
      const detail =
        [description(feature, lang), featureCity(feature)].filter(Boolean).join(", ") || undefined;
      let transitStop: TransitStop | undefined;
      if (isStop(feature))
        transitStop = {
          id: base.id,
          primaryScheme: geocoderFeatureIdentity(feature).primaryScheme,
          ids: base.ids,
          name,
          lat: base.coordinates[1],
          lng: base.coordinates[0],
          modes: geocoderFeatureModes(feature),
          provider: "entur",
          contributors: base.contributors,
        };
      const iconCategory =
        base.rawCategory === "railStation" || base.rawCategory === "vehicleRailInterchange"
          ? "railway_station"
          : base.rawCategory;
      return {
        ...base,
        label: name,
        sublabel: detail,
        type: transitStop ? "transit_stop" : type(feature),
        ...(transitStop
          ? { transitStop }
          : iconCategory
            ? { iconPath: resolvePoiIconPath(iconCategory) }
            : {}),
      };
    },
    place(feature: EnturGeocoderFeature, lang?: string): Place {
      const base = common(feature);
      const countryCode = feature.properties.address?.countryCode;
      const place = createPlace({
        primaryScheme: geocoderFeatureIdentity(feature).primaryScheme,
        ids: base.ids,
        name: feature.properties.names.default,
        address: feature.properties.names.display,
        city: featureCity(feature),
        countryCode:
          countryCode && /^[a-z]{2}$/i.test(countryCode) ? countryCode.toLowerCase() : undefined,
        coordinates: base.coordinates,
        category: isStop(feature) ? "station" : type(feature),
        rawCategory: base.rawCategory,
        description: description(feature, lang),
        contributors: base.contributors,
      });
      const fields = Object.fromEntries(
        Object.entries(place)
          .filter(([field, value]) => field !== "contributors" && value !== undefined)
          .map(([field]) => [field, base.contributors]),
      );
      for (const scheme of Object.keys(place.ids)) fields[`ids.${scheme}`] = base.contributors;
      place.fieldContributors = fields;
      return place;
    },
  };
}

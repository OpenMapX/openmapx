// Ranked POIs in OpenMapTiles are locally ordered within a grid, not globally
// comparable across categories. Introduce each kind gradually so low-zoom maps
// favour destinations and transit over routine shops and street furniture.
// Values are maximum tile ranks at integer zooms 14 through 20; 0 hides a kind.
const zooms = [14, 15, 16, 17, 18, 19, 20];
const all = 9999;

export const poiVisibilityGroups = [
  {
    classes: [
      "attraction",
      "castle",
      "monument",
      "zoo",
      "aquarium",
      "amusement_park",
      "theme_park",
      "stadium",
      "airport",
      "railway",
      "hospital",
      "viewpoint",
    ],
    limits: [8, 20, 40, 100, all, all, all],
  },
  {
    classes: ["museum"],
    limits: [12, 35, 80, 220, all, all, all],
  },
  {
    classes: ["art_gallery", "theatre", "cinema"],
    limits: [0, 12, 45, 85, 180, all, all],
  },
  {
    classes: [
      "town_hall",
      "library",
      "police",
      "fire_station",
      "place_of_worship",
      "college",
      "harbor",
      "ferry_terminal",
      "garden",
      "beach",
      "cemetery",
    ],
    limits: [0, 6, 25, 50, 130, all, all],
  },
  {
    classes: ["restaurant", "cafe", "bar", "beer", "bakery", "ice_cream"],
    limits: [0, 0, 25, 115, 220, all, all],
  },
  {
    classes: ["fast_food"],
    limits: [0, 0, 22, 42, 110, all, all],
  },
  {
    classes: ["lodging", "campsite"],
    limits: [0, 0, 25, 78, 180, all, all],
  },
  {
    classes: ["shop", "grocery", "clothing_store", "alcohol_shop", "parking"],
    limits: [0, 0, 12, 22, 65, 140, all],
  },
  {
    classes: ["bus"],
    limits: [0, 0, 0, 3, 7, 15, all],
  },
  {
    classes: [
      "school",
      "office",
      "bank",
      "atm",
      "doctors",
      "dentist",
      "pharmacy",
      "veterinary",
      "information",
      "playground",
      "sports_centre",
      "swimming_pool",
      "golf",
      "dog_park",
      "pitch",
      "post",
      "bicycle_rental",
      "car",
      "fuel",
      "taxi",
      "airfield",
      "waterfall",
      "shelter",
      "music",
      "escape_game",
      "sailing",
      "tennis",
      "cycling",
      "basketball",
      "swimming",
      "picnic_site",
      "horse_racing",
      "paragliding",
      "laundry",
      "hairdresser",
    ],
    limits: [0, 0, 0, 8, 35, 90, all],
  },
  {
    classes: [
      "toilets",
      "recycling",
      "drinking_water",
      "telephone",
      "gate",
      "lift_gate",
      "entrance",
      "bicycle",
    ],
    limits: [0, 0, 0, 0, 10, 50, all],
  },
];

const fallbackLimits = [0, 0, 0, 0, 10, 50, all];

// Bus and tram stops are many small points that mostly repeat a nearby
// station's name. They arrive as icons from z16; their names come from the
// merged stop-label layer rather than from every platform.
export const transitStopLimits = [0, 0, 4, 10, 30, all, all];

export function isTransitStop(poiClass, subclass) {
  return (poiClass === "bus" && subclass !== "bus_station") || subclass === "tram_stop";
}

export function transitStopExpression() {
  return [
    "any",
    [
      "all",
      ["==", ["get", "class"], "bus"],
      ["!=", ["coalesce", ["get", "subclass"], ""], "bus_station"],
    ],
    ["==", ["get", "subclass"], "tram_stop"],
  ];
}

export function poiRankLimit(poiClass, zoom, subclass) {
  if (
    ["waste_basket", "bicycle_parking", "bollard", "motorcycle_parking", "cycle_barrier"].includes(
      poiClass,
    )
  )
    return 0;
  const index = Math.max(0, Math.min(zooms.length - 1, Math.floor(zoom) - zooms[0]));
  if (isTransitStop(poiClass, subclass)) return transitStopLimits[index];
  return (poiVisibilityGroups.find((group) => group.classes.includes(poiClass))?.limits ??
    fallbackLimits)[index];
}

function zoomStep(limits) {
  return ["step", ["zoom"], 0, ...zooms.flatMap((zoom, index) => [zoom, limits[index]])];
}

export function transitStopRankLimitExpression() {
  return zoomStep(transitStopLimits);
}

export function poiRankLimitExpression() {
  return [
    "case",
    transitStopExpression(),
    transitStopRankLimitExpression(),
    [
      "match",
      ["get", "class"],
      ...poiVisibilityGroups.flatMap(({ classes, limits }) => [classes, zoomStep(limits)]),
      zoomStep(fallbackLimits),
    ],
  ];
}

// How many languages a POI has a name in is a usable proxy for fame: the
// Brandenburg Gate or a cathedral carries names in fifteen or twenty
// languages, a local fountain or a clock in two or three. English and German
// are left out because local mappers add those to ordinary places.
export const notabilityLanguages = [
  "ar",
  "cs",
  "da",
  "el",
  "es",
  "fa",
  "fi",
  "fr",
  "he",
  "hu",
  "it",
  "ja",
  "ko",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "tr",
  "uk",
  "zh",
];

export const landmarkClasses = [
  "attraction",
  "castle",
  "monument",
  "museum",
  "place_of_worship",
  "theatre",
  "library",
  "art_gallery",
  "zoo",
  "aquarium",
  "stadium",
  "theme_park",
  "amusement_park",
  "viewpoint",
];

export const landmarkMinLanguages = 6;

export function notabilityExpression() {
  return ["+", ...notabilityLanguages.map((code) => ["case", ["has", `name:${code}`], 1, 0])];
}

export function landmarkExpression() {
  return [
    "all",
    ["in", ["get", "class"], ["literal", landmarkClasses]],
    [">=", notabilityExpression(), landmarkMinLanguages],
  ];
}

export function streetFixtureFilter() {
  return [
    "all",
    ["==", ["geometry-type"], "Point"],
    [
      "match",
      ["get", "class"],
      "bicycle_parking",
      [">=", ["zoom"], 19],
      "motorcycle_parking",
      [">=", ["zoom"], 19],
      ["waste_basket", "bollard", "cycle_barrier"],
      [">=", ["zoom"], 20],
      false,
    ],
    ["any", ["!", ["has", "level"]], ["==", ["get", "level"], 0]],
  ];
}

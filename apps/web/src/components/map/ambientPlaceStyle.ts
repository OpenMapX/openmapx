import type {
  ExpressionSpecification,
  LayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

// Publication categories use OSM/Overture names. Rendering alone adapts these
// to OpenMapTiles classes; canonical identities and published data stay intact.
const classAliases: Record<string, string> = {
  association: "office",
  company: "office",
  government: "office",
  educational_institution: "office",
  lawyer: "office",
  accountant: "office",
  insurance: "office",
  estate_agent: "office",
  architect: "office",
  ngo: "office",
  diplomatic: "office",
  employment_agency: "office",
  newspaper: "office",
  notary: "office",
  tax_advisor: "office",
  attorney_or_law_firm: "office",
  legal_service: "office",
  financial_service: "office",
  real_estate_service: "office",
  corporate_or_business_office: "office",
  professional_service: "office",
  fashion_and_apparel_store: "clothing_store",
  dental_clinic: "dentist",
  diagnostics_imaging_or_lab_service: "doctors",
  behavioral_or_mental_health_clinic: "doctors",
  physical_medicine_and_rehabilitation: "doctors",
  outpatient_care_facility: "doctors",
  private_lodging: "lodging",
  bars: "bar",
  hairdressers: "hairdresser",
  dentists: "dentist",
  veterinarians: "veterinary",
  cinemas: "cinema",
  gyms: "sports_centre",
  laundromats: "laundry",
  bookstores: "library",
  shopping_malls: "shop",
  markets: "grocery",
  nightlife: "bar",
  opticians: "shop",
  doctor: "doctors",
  supermarket: "grocery",
  department_store: "grocery",
  marketplace: "grocery",
  clothes: "clothing_store",
  alcohol: "alcohol_shop",
  townhall: "town_hall",
  community_centre: "town_hall",
  courthouse: "town_hall",
  post_office: "post",
  parcel_locker: "post",
  post_box: "post",
  kindergarten: "school",
  university: "college",
  station: "railway",
  tram_stop: "railway",
  bus_stop: "bus",
  bus_station: "bus",
  aerodrome: "airport",
  charging_station: "fuel",
  gas_station: "fuel",
  car_repair: "car",
  hotel: "lodging",
  hostel: "lodging",
  motel: "lodging",
  guest_house: "lodging",
  gallery: "art_gallery",
  archaeological_site: "monument",
  ruins: "castle",
  fitness_centre: "sports_centre",
  food_court: "fast_food",
  nightclub: "bar",
  books: "library",
};

const shopSubclasses = [
  "convenience",
  "kiosk",
  "beauty",
  "gift",
  "jewelry",
  "furniture",
  "mall",
  "florist",
  "hardware",
  "doityourself",
  "shoes",
  "mobile_phone",
  "pet",
  "ticket",
  "travel_agency",
  "garden_centre",
  "electronics",
  "computer",
  "massage",
  "tattoo",
  "cosmetics",
  "perfumery",
  "tailor",
  "accessories",
  "motorcycle",
  "locksmith",
  "watches",
  "paint",
  "fabric",
  "chemist",
  "optician",
  "hearing_aids",
  "coffee",
  "chocolate",
  "confectionery",
];
const categoryClass = [
  "match",
  ["get", "category"],
  shopSubclasses,
  "shop",
  ...Object.entries(classAliases).flat(),
  ["get", "category"],
] as ExpressionSpecification;

/** Remap only feature lookups, leaving literal labels and sprite names alone. */
function adapt(value: unknown): unknown {
  if (!Array.isArray(value) || value[0] === "literal") return value;
  if (value[0] === "get" && value.length === 2) {
    if (value[1] === "class") return categoryClass;
    if (value[1] === "subclass") return ["get", "category"];
  }
  if (
    value[0] === "match" &&
    Array.isArray(value[1]) &&
    value[1][0] === "get" &&
    value[1][1] === "class"
  ) {
    // Unknown destinations still use a native POI badge when the style has
    // a generic class. Borrow that branch; never assume a sprite exists.
    const adapted = value.map(adapt);
    for (let index = 2; index < value.length - 1; index += 2) {
      const labels = Array.isArray(value[index]) ? value[index] : [value[index]];
      if (labels.includes("multi")) {
        adapted[adapted.length - 1] = adapt(value[index + 1]);
        break;
      }
    }
    return adapted;
  }
  return value.map(adapt);
}

/** Legacy hosted styles use token strings rather than feature expressions. */
function adaptSpriteTokens(value: string): string | ExpressionSpecification {
  if (!/\{(?:class|subclass)\}/.test(value)) return value;
  return [
    "concat",
    ...value
      .split(/(\{(?:class|subclass)\})/)
      .filter(Boolean)
      .map((part) =>
        part === "{class}" ? categoryClass : part === "{subclass}" ? ["get", "category"] : part,
      ),
  ] as ExpressionSpecification;
}

/** Borrow the active style's assets and cartography, including hosted styles. */
export function ambientPlaceStyle(
  layers: readonly LayerSpecification[],
  landmark: boolean,
  dark: boolean,
): Pick<SymbolLayerSpecification, "layout" | "paint"> {
  const ordinary =
    layers.find((layer) => layer.id === "poi-level-1" && layer.type === "symbol") ??
    layers.find(
      (layer) =>
        layer.type === "symbol" && layer["source-layer"] === "poi" && layer.layout?.["text-field"],
    );
  const template = landmark
    ? (layers.find((layer) => layer.id === "poi-landmark" && layer.type === "symbol") ?? ordinary)
    : ordinary;
  const symbol = template?.type === "symbol" ? template : undefined;
  const layout = symbol?.layout ?? {};
  return {
    layout: {
      // Keep unrelated basemap visibility, filters and sort keys out of this
      // source. Placement and zoom eligibility remain publication-owned.
      "icon-image": (typeof layout["icon-image"] === "string"
        ? adaptSpriteTokens(layout["icon-image"])
        : adapt(layout["icon-image"])) as NonNullable<
        SymbolLayerSpecification["layout"]
      >["icon-image"],
      // A larger landmark badge can collide where a normal native POI fits.
      // Keep the stronger landmark label with the ordinary native badge size.
      "icon-size": adapt(
        ordinary?.type === "symbol" ? (ordinary.layout?.["icon-size"] ?? 1) : 1,
      ) as NonNullable<SymbolLayerSpecification["layout"]>["icon-size"],
      "icon-padding": layout["icon-padding"] ?? 2,
      "text-font": layout["text-font"] ?? ["Noto Sans Regular"],
      "text-size": layout["text-size"] ?? 12,
      "text-max-width": landmark ? 6 : (layout["text-max-width"] ?? 9),
      "text-padding": layout["text-padding"] ?? 2,
      "text-anchor": "top",
      "text-variable-anchor-offset": [
        "literal",
        landmark
          ? [
              "top",
              [0, 1.3],
              "bottom",
              [0, -1.3],
              "left",
              [1.3, 0],
              "right",
              [-1.3, 0],
              "top-left",
              [0.92, 0.92],
              "top-right",
              [-0.92, 0.92],
            ]
          : ["top", [0, 1.05]],
      ],
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      // Keep the badge and label together, as one native POI.
      "icon-optional": false,
      "text-optional": false,
    },
    paint: {
      ...(symbol?.paint
        ? Object.fromEntries(
            Object.entries(symbol.paint).map(([key, value]) => [key, adapt(value)]),
          )
        : {
            "text-color": dark ? "#9aa0a6" : "#5f6368",
            "text-halo-color": dark ? "rgba(11, 15, 20, 0.85)" : "rgba(255,255,255,0.8)",
            "text-halo-width": 1,
            "text-halo-blur": 0.5,
          }),
    },
  };
}

// OpenMapTiles POI class defaults plus meaningful subclass overrides.
// A key is either `class` or `class/subclass`. Library names refer to the
// Maki and Temaki SVGs already used for preset icons in this app.
// `text` and `darkText` are the badge colour shifted until a label reaches
// 5:1 contrast on the light map and 6:1 on the dark one.
export const poiIconGroups = [
  {
    category: "food",
    colour: "#ad633d",
    text: "#9a5836",
    darkText: "#ce9273",
    icons: {
      restaurant: "maki:restaurant",
      cafe: "maki:cafe",
      fast_food: "maki:fast-food",
      bar: "maki:bar",
      beer: "maki:beer",
      bakery: "maki:bakery",
      ice_cream: "maki:ice-cream",
      butcher: "temaki:cleaver",
      "shop/coffee": "maki:cafe",
      "shop/chocolate": "temaki:chocolate",
      "shop/confectionery": "maki:confectionery",
      "fast_food/food_court": "temaki:food",
      "bar/nightclub": "maki:nightclub",
    },
  },
  {
    category: "shopping",
    colour: "#8a638e",
    text: "#815d85",
    darkText: "#b397b6",
    icons: {
      shop: "maki:shop",
      "shop/convenience": "maki:convenience",
      "shop/kiosk": "maki:shop",
      "shop/beauty": "temaki:beauty_salon",
      "shop/gift": "maki:gift",
      "shop/jewelry": "maki:jewelry-store",
      "shop/furniture": "maki:furniture",
      "shop/mall": "temaki:shopping_mall",
      "shop/florist": "maki:florist",
      "shop/hardware": "maki:hardware",
      "shop/doityourself": "maki:hardware",
      "shop/shoes": "maki:shoe",
      "shop/mobile_phone": "maki:mobile-phone",
      "shop/pet": "temaki:pet_store",
      "shop/ticket": "temaki:ticket",
      "shop/travel_agency": "maki:suitcase",
      "shop/garden_centre": "maki:garden-centre",
      "shop/electronics": "temaki:electronic",
      "shop/computer": "temaki:electronic",
      "shop/massage": "temaki:spa",
      "shop/tattoo": "temaki:tattoo_machine",
      "shop/cosmetics": "temaki:lipstick",
      "shop/perfumery": "temaki:perfume",
      "shop/tailor": "temaki:needle_and_spool",
      "shop/accessories": "temaki:fashion_accessories",
      "shop/motorcycle": "temaki:motorcycle",
      "shop/locksmith": "temaki:lock",
      "shop/watches": "maki:watch",
      "shop/paint": "maki:paint",
      "shop/fabric": "temaki:cloth",
      grocery: "maki:grocery",
      "grocery/marketplace": "maki:commercial",
      "grocery/department_store": "temaki:shopping_mall",
      clothing_store: "maki:clothing-store",
      alcohol_shop: "maki:alcohol-shop",
      hairdresser: "maki:hairdresser",
      laundry: "maki:laundry",
    },
  },
  {
    category: "transport",
    colour: "#477aa1",
    text: "#3f6d8f",
    darkText: "#7aa4c4",
    icons: {
      bus: "maki:bus",
      "bus/bus_station": "temaki:board_bus",
      railway: "maki:rail",
      "railway/tram_stop": "temaki:tram",
      "railway/subway": "temaki:subway",
      "railway/station": "temaki:train",
      "railway/halt": "temaki:train",
      "entrance/subway_entrance": "temaki:subway",
      "entrance/train_station_entrance": "temaki:train",
      parking: "maki:parking",
      motorcycle_parking: "temaki:motorcycle_parked",
      toll_booth: "maki:toll",
      "aerialway/station": "maki:aerialway",
      bicycle_rental: "maki:bicycle-share",
      bicycle: "maki:bicycle",
      car: "maki:car",
      "car/car_repair": "maki:car-repair",
      fuel: "maki:fuel",
      "fuel/charging_station": "maki:charging-station",
      ferry_terminal: "maki:ferry",
      harbor: "maki:harbor",
      taxi: "maki:taxi",
      airport: "maki:airport",
      airfield: "maki:airfield",
    },
  },
  {
    category: "civic",
    colour: "#64816e",
    text: "#57705f",
    darkText: "#8ca695",
    icons: {
      school: "maki:school",
      college: "maki:college",
      library: "maki:library",
      "library/books": "temaki:book_store",
      town_hall: "maki:town-hall",
      "town_hall/community_centre": "temaki:social_facility",
      "town_hall/courthouse": "temaki:courthouse",
      police: "maki:police",
      post: "maki:post",
      "post/parcel_locker": "temaki:vending_lockers",
      "post/post_box": "temaki:post_box",
      fire_station: "maki:fire-station",
      office: "maki:building",
      "office/company": "maki:building",
      "office/government": "maki:town-hall",
      "office/diplomatic": "maki:embassy",
      "office/educational_institution": "maki:college",
      "office/estate_agent": "temaki:real_estate_agency",
      "office/lawyer": "temaki:lawyer",
      "office/accountant": "temaki:accounting",
      bank: "maki:bank",
      atm: "temaki:atm",
      information: "maki:information",
      "information/board": "temaki:info_board",
      "information/map": "temaki:bulletin_board",
      "information/terminal": "maki:terminal",
    },
  },
  {
    category: "health",
    colour: "#b65b65",
    text: "#a84b55",
    darkText: "#ce9097",
    icons: {
      hospital: "maki:hospital",
      "hospital/clinic": "maki:hospital",
      doctors: "maki:doctor",
      dentist: "maki:dentist",
      pharmacy: "maki:pharmacy",
      veterinary: "maki:veterinary",
      "shop/chemist": "maki:pharmacy",
      "shop/optician": "maki:optician",
      "shop/hearing_aids": "temaki:hearing_aid",
    },
  },
  {
    category: "culture",
    colour: "#756ba0",
    text: "#6d6299",
    darkText: "#a09abe",
    icons: {
      attraction: "maki:attraction",
      "attraction/viewpoint": "maki:viewpoint",
      art_gallery: "maki:art-gallery",
      museum: "maki:museum",
      theatre: "maki:theatre",
      cinema: "maki:cinema",
      castle: "maki:castle",
      "castle/ruins": "temaki:ruins",
      monument: "maki:monument",
      zoo: "maki:zoo",
      aquarium: "maki:aquarium",
      amusement_park: "maki:amusement-park",
      theme_park: "maki:amusement-park",
      escape_game: "maki:gaming",
      music: "maki:music",
      place_of_worship: "maki:place-of-worship",
      "place_of_worship/christian": "maki:religious-christian",
      "place_of_worship/muslim": "maki:religious-muslim",
      "place_of_worship/hindu": "temaki:hinduism",
      "place_of_worship/buddhist": "maki:religious-buddhist",
      "place_of_worship/shinto": "maki:religious-shinto",
      lodging: "maki:lodging",
      "lodging/hostel": "temaki:bunk_beds",
    },
  },
  {
    category: "outdoors",
    colour: "#568575",
    text: "#4a7265",
    darkText: "#7aa999",
    icons: {
      garden: "maki:garden",
      playground: "maki:playground",
      sports_centre: "maki:fitness-centre",
      stadium: "maki:stadium",
      swimming_pool: "maki:swimming",
      golf: "maki:golf",
      dog_park: "maki:dog-park",
      beach: "maki:beach",
      campsite: "maki:campsite",
      shelter: "maki:shelter",
      cemetery: "maki:cemetery",
      viewpoint: "maki:viewpoint",
      pitch: "maki:pitch",
      waterfall: "maki:waterfall",
      sailing: "temaki:sailing",
      tennis: "maki:tennis",
      cycling: "maki:bicycle",
      basketball: "maki:basketball",
      swimming: "maki:swimming",
      picnic_site: "maki:picnic-site",
      horse_racing: "maki:racetrack-horse",
      paragliding: "temaki:hang_gliding",
      yoga: "maki:fitness-centre",
      running: "temaki:racetrack_oval",
      athletics: "temaki:racetrack_oval",
      multi: "maki:pitch",
      table_tennis: "maki:table-tennis",
      ice_rink: "temaki:ice_skating",
      climbing: "temaki:climbing",
      volleyball: "maki:volleyball",
      equestrian: "maki:horse-riding",
      table_soccer: "temaki:table_soccer",
      skateboard: "maki:skateboard",
      motor: "maki:racetrack",
      "pitch/table_tennis": "maki:table-tennis",
      "pitch/basketball": "maki:basketball",
      "pitch/tennis": "maki:tennis",
      "pitch/soccer": "maki:soccer",
      "pitch/skateboard": "maki:skateboard",
    },
  },
  {
    category: "utility",
    colour: "#738087",
    text: "#606b71",
    darkText: "#96a0a6",
    icons: {
      toilets: "maki:toilet",
      recycling: "maki:recycling",
      drinking_water: "maki:drinking-water",
      telephone: "maki:telephone",
      gate: "maki:gate",
      lift_gate: "maki:lift-gate",
      waste_basket: "maki:waste-basket",
      bicycle_parking: "temaki:bicycle_parked",
      bollard: "temaki:bollard",
      cycle_barrier: "temaki:cycle_barrier",
      sally_port: "maki:gate",
      stile: "maki:gate",
    },
  },
];

// Classes the registry does not know keep the neutral grey all labels used to have.
export const poiFallbackTextColour = "#5f6368";

/**
 * A POI's badge: its subclass's if there is one, else its class's, else the
 * basemap's older `<class>_11` glyph, else a marker. Every image is named
 * outright rather than tried in turn, because MapLibre warns about each name
 * it asks the sprite for and does not find.
 */
export function poiIconImageExpression(glyphNames) {
  const subclassBranches = [];
  const classBranches = [];
  const classes = new Set();
  for (const group of poiIconGroups) {
    for (const key of Object.keys(group.icons)) {
      const image = ["image", `poi-${key.replace("/", "-")}`];
      if (key.includes("/")) {
        subclassBranches.push(key, image);
      } else {
        classBranches.push(key, image);
        classes.add(key);
      }
    }
  }
  for (const name of glyphNames) {
    const poiClass = name.replace(/_11$/, "");
    if (poiClass !== name && !classes.has(poiClass)) classBranches.push(poiClass, ["image", name]);
  }
  return [
    "match",
    ["concat", ["get", "class"], "/", ["coalesce", ["get", "subclass"], ""]],
    ...subclassBranches,
    ["match", ["get", "class"], ...classBranches, ["image", "marker_11"]],
  ];
}

/** A label takes its badge's category colour; a subclass override wins over its class. */
export function poiTextColourExpression() {
  const subclassBranches = [];
  const classBranches = [];
  for (const group of poiIconGroups) {
    const keys = Object.keys(group.icons);
    const subclassKeys = keys.filter((key) => key.includes("/"));
    const classKeys = keys.filter((key) => !key.includes("/"));
    if (subclassKeys.length > 0) subclassBranches.push(subclassKeys, group.text);
    if (classKeys.length > 0) classBranches.push(classKeys, group.text);
  }
  return [
    "match",
    ["concat", ["get", "class"], "/", ["coalesce", ["get", "subclass"], ""]],
    ...subclassBranches,
    ["match", ["get", "class"], ...classBranches, poiFallbackTextColour],
  ];
}

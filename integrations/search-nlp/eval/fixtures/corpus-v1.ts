export type SemanticNegativeFamily =
  | "proper-name"
  | "brand"
  | "address-code"
  | "ambiguous"
  | "no-place-type"
  | "unsupported-category";

export interface SemanticTaxonomyCaseV1 {
  id: string;
  query: string;
  lang: "en" | "de";
  split: "development" | "test";
  expected:
    | { status: "category"; acceptableCategoryIds: string[] }
    | { status: "abstain"; reasonFamily: SemanticNegativeFamily };
  strata: {
    kind: "direct" | "paraphrase" | "semantic-only" | "structured" | "negative";
    categoryFamily: string;
    conceptFamily: string;
    p0: boolean;
  };
  evidence: string;
}

interface PositiveSeed {
  categoryId: string;
  split: "development" | "test";
  acceptable?: string[];
  semantic: { en: string; de: string };
  structured: { en: string; de: string };
}

const POSITIVE_SEEDS: readonly PositiveSeed[] = [
  {
    categoryId: "activities",
    split: "development",
    semantic: {
      en: "a fun day out with animals or rides",
      de: "ein Ausflug mit Tieren oder Fahrgeschäften",
    },
    structured: {
      en: "a wheelchair accessible attraction near me",
      de: "eine barrierefreie Attraktion in meiner Nähe",
    },
  },
  {
    categoryId: "aeds",
    split: "development",
    semantic: {
      en: "someone collapsed and we need a defibrillator",
      de: "jemand ist zusammengebrochen und wir brauchen einen Defibrillator",
    },
    structured: {
      en: "nearest accessible emergency defibrillator",
      de: "nächster barrierefreier Defibrillator für den Notfall",
    },
  },
  {
    categoryId: "airports",
    split: "development",
    semantic: { en: "where can I catch a flight", de: "wo kann ich einen Flug nehmen" },
    structured: {
      en: "airport terminal closest to me",
      de: "das nächstgelegene Flughafenterminal",
    },
  },
  {
    categoryId: "ambulance_stations",
    split: "development",
    semantic: {
      en: "where are emergency medical crews based",
      de: "wo sind Rettungswagen stationiert",
    },
    structured: {
      en: "nearest ambulance station open around the clock",
      de: "nächste rund um die Uhr besetzte Rettungswache",
    },
  },
  {
    categoryId: "atms",
    split: "test",
    semantic: { en: "I need to withdraw cash", de: "ich muss Bargeld abheben" },
    structured: {
      en: "wheelchair accessible cash machine nearby",
      de: "barrierefreier Geldautomat in der Nähe",
    },
  },
  {
    categoryId: "bakeries",
    split: "development",
    semantic: {
      en: "somewhere selling fresh bread and pastries",
      de: "irgendwo mit frischem Brot und Gebäck",
    },
    structured: { en: "bakery open early near me", de: "früh geöffnete Bäckerei in meiner Nähe" },
  },
  {
    categoryId: "banks",
    split: "development",
    semantic: {
      en: "I need to speak with someone about my account",
      de: "ich muss mit jemandem über mein Konto sprechen",
    },
    structured: {
      en: "wheelchair accessible bank open now",
      de: "jetzt geöffnete barrierefreie Bank",
    },
  },
  {
    categoryId: "bars",
    split: "development",
    semantic: {
      en: "somewhere for a beer after work",
      de: "irgendwo nach der Arbeit ein Bier trinken",
    },
    structured: {
      en: "pub with outdoor seating open tonight",
      de: "heute Abend geöffnete Kneipe mit Außenplätzen",
    },
  },
  {
    categoryId: "beaches",
    split: "development",
    semantic: { en: "a sandy place by the water", de: "ein sandiger Ort am Wasser" },
    structured: { en: "closest wheelchair accessible beach", de: "nächster barrierefreier Strand" },
  },
  {
    categoryId: "bicycle_rental",
    split: "development",
    semantic: {
      en: "I want to hire a bike for the afternoon",
      de: "ich möchte für den Nachmittag ein Fahrrad ausleihen",
    },
    structured: {
      en: "bicycle rental open now near me",
      de: "jetzt geöffneter Fahrradverleih in meiner Nähe",
    },
  },
  {
    categoryId: "blood_donation",
    split: "development",
    semantic: { en: "where can I give blood", de: "wo kann ich Blut spenden" },
    structured: {
      en: "blood donation centre open Saturday",
      de: "samstags geöffnete Blutspendestelle",
    },
  },
  {
    categoryId: "bookstores",
    split: "test",
    semantic: { en: "where can I buy books", de: "wo kann ich Bücher kaufen" },
    structured: {
      en: "book shop open late nearby",
      de: "lange geöffnete Buchhandlung in der Nähe",
    },
  },
  {
    categoryId: "cafes",
    split: "development",
    semantic: { en: "somewhere for coffee and cake", de: "irgendwo Kaffee und Kuchen bekommen" },
    structured: {
      en: "quiet cafe with wifi open now",
      de: "ruhiges Café mit WLAN, das jetzt geöffnet ist",
    },
  },
  {
    categoryId: "camping",
    split: "development",
    semantic: {
      en: "a place to pitch my tent overnight",
      de: "ein Platz zum Übernachten mit dem Zelt",
    },
    structured: {
      en: "cheap campsite near me with showers",
      de: "günstiger Campingplatz mit Duschen in der Nähe",
    },
  },
  {
    categoryId: "car_rental",
    split: "development",
    semantic: {
      en: "I need to hire a car for two days",
      de: "ich muss für zwei Tage ein Auto mieten",
    },
    structured: {
      en: "car rental desk open Sunday near the airport",
      de: "sonntags geöffnete Autovermietung nahe dem Flughafen",
    },
  },
  {
    categoryId: "car_repair",
    split: "test",
    semantic: { en: "my car needs fixing", de: "mein Auto muss repariert werden" },
    structured: {
      en: "car workshop open now near me",
      de: "jetzt geöffnete Autowerkstatt in meiner Nähe",
    },
  },
  {
    categoryId: "churches",
    split: "development",
    semantic: { en: "a Christian place for prayer", de: "ein christlicher Ort zum Beten" },
    structured: {
      en: "wheelchair accessible church nearby",
      de: "barrierefreie Kirche in der Nähe",
    },
  },
  {
    categoryId: "cinemas",
    split: "development",
    semantic: { en: "somewhere showing films tonight", de: "irgendwo laufen heute Abend Filme" },
    structured: {
      en: "cinema with wheelchair access near me",
      de: "Kino mit barrierefreiem Zugang in meiner Nähe",
    },
  },
  {
    categoryId: "dentists",
    split: "development",
    semantic: {
      en: "someone who can treat my toothache",
      de: "jemand, der meine Zahnschmerzen behandeln kann",
    },
    structured: {
      en: "dentist open now and wheelchair accessible",
      de: "jetzt geöffnete barrierefreie Zahnarztpraxis",
    },
  },
  {
    categoryId: "doctors",
    split: "development",
    semantic: {
      en: "I need a medical appointment for an illness",
      de: "ich brauche wegen einer Krankheit einen Arzttermin",
    },
    structured: {
      en: "doctor open this afternoon near me",
      de: "heute Nachmittag geöffnete Arztpraxis in meiner Nähe",
    },
  },
  {
    categoryId: "dog_parks",
    split: "development",
    semantic: {
      en: "somewhere my dog can run off leash",
      de: "irgendwo kann mein Hund ohne Leine laufen",
    },
    structured: {
      en: "nearest fenced dog exercise area",
      de: "nächste eingezäunte Auslauffläche für Hunde",
    },
  },
  {
    categoryId: "drinking_water",
    split: "development",
    semantic: { en: "refill my drinking bottle", de: "meine Trinkflasche auffüllen" },
    structured: {
      en: "free drinking water closest to me",
      de: "kostenloses Trinkwasser ganz in meiner Nähe",
    },
  },
  {
    categoryId: "fire_stations",
    split: "development",
    semantic: {
      en: "where are the local firefighters based",
      de: "wo ist die örtliche Feuerwehr stationiert",
    },
    structured: {
      en: "nearest fire station open around the clock",
      de: "nächste rund um die Uhr besetzte Feuerwache",
    },
  },
  {
    categoryId: "gyms",
    split: "development",
    semantic: {
      en: "somewhere to lift weights and exercise",
      de: "irgendwo Gewichte heben und trainieren",
    },
    structured: {
      en: "cheap wheelchair accessible gym open late",
      de: "günstiges barrierefreies Fitnessstudio, das lange geöffnet ist",
    },
  },
  {
    categoryId: "hairdressers",
    split: "test",
    semantic: { en: "I need a haircut", de: "ich brauche einen Haarschnitt" },
    structured: {
      en: "hair salon open now near me",
      de: "jetzt geöffneter Friseursalon in meiner Nähe",
    },
  },
  {
    categoryId: "hospitals",
    split: "development",
    semantic: {
      en: "a place for serious medical treatment",
      de: "ein Ort für eine ernsthafte medizinische Behandlung",
    },
    structured: {
      en: "nearest hospital emergency department open now",
      de: "nächste jetzt geöffnete Notaufnahme eines Krankenhauses",
    },
  },
  {
    categoryId: "hotels",
    split: "test",
    semantic: { en: "a place to sleep overnight", de: "ein Ort zum Übernachten" },
    structured: {
      en: "cheap wheelchair accessible room for tonight",
      de: "günstiges barrierefreies Zimmer für heute Nacht",
    },
  },
  {
    categoryId: "kindergartens",
    split: "development",
    semantic: {
      en: "daytime care for my preschool child",
      de: "Tagesbetreuung für mein Vorschulkind",
    },
    structured: {
      en: "kindergarten near me with wheelchair access",
      de: "Kindergarten mit barrierefreiem Zugang in meiner Nähe",
    },
  },
  {
    categoryId: "laundromats",
    split: "test",
    semantic: { en: "somewhere to wash my clothes", de: "irgendwo meine Wäsche waschen" },
    structured: {
      en: "self service laundry open late nearby",
      de: "lange geöffneter Waschsalon zur Selbstbedienung in der Nähe",
    },
  },
  {
    categoryId: "libraries",
    split: "test",
    semantic: { en: "somewhere quiet to study", de: "ein ruhiger Ort zum Lernen" },
    structured: {
      en: "library with wheelchair access open Sunday",
      de: "sonntags geöffnete barrierefreie Bibliothek",
    },
  },
  {
    categoryId: "markets",
    split: "development",
    semantic: { en: "stalls selling local produce", de: "Stände mit regionalen Lebensmitteln" },
    structured: {
      en: "outdoor market open Saturday near me",
      de: "samstags geöffneter Markt im Freien in meiner Nähe",
    },
  },
  {
    categoryId: "mosques",
    split: "test",
    semantic: { en: "a place for Muslim prayer", de: "ein Ort für das muslimische Gebet" },
    structured: {
      en: "wheelchair accessible mosque nearby",
      de: "barrierefreie Moschee in der Nähe",
    },
  },
  {
    categoryId: "museums",
    split: "development",
    semantic: {
      en: "somewhere to see historical exhibits",
      de: "irgendwo historische Ausstellungen ansehen",
    },
    structured: {
      en: "free museum open today near me",
      de: "heute geöffnetes kostenloses Museum in meiner Nähe",
    },
  },
  {
    categoryId: "nightlife",
    split: "development",
    semantic: { en: "somewhere to dance after midnight", de: "irgendwo nach Mitternacht tanzen" },
    structured: {
      en: "nightclub open late with wheelchair access",
      de: "lange geöffneter Nachtclub mit barrierefreiem Zugang",
    },
  },
  {
    categoryId: "opticians",
    split: "development",
    semantic: {
      en: "someone who can test my eyesight",
      de: "jemand, der meine Sehstärke prüfen kann",
    },
    structured: {
      en: "optician open Saturday near me",
      de: "samstags geöffneter Optiker in meiner Nähe",
    },
  },
  {
    categoryId: "parking",
    split: "development",
    semantic: { en: "somewhere safe to leave the car", de: "irgendwo das Auto sicher abstellen" },
    structured: {
      en: "wheelchair parking level 2 near the entrance",
      de: "barrierefreier Parkplatz auf Ebene 2 nahe dem Eingang",
    },
  },
  {
    categoryId: "parks",
    split: "test",
    acceptable: ["parks", "activities"],
    semantic: { en: "somewhere for children to play outside", de: "draußen spielen für Kinder" },
    structured: {
      en: "quiet wheelchair accessible green space nearby",
      de: "ruhige barrierefreie Grünanlage in der Nähe",
    },
  },
  {
    categoryId: "pharmacies",
    split: "test",
    semantic: { en: "where can I get medicine", de: "wo bekomme ich Medikamente" },
    structured: { en: "24 hour pharmacy near me", de: "24h Apotheke in meiner Nähe" },
  },
  {
    categoryId: "police",
    split: "development",
    semantic: {
      en: "where can I report a crime in person",
      de: "wo kann ich persönlich eine Straftat melden",
    },
    structured: {
      en: "nearest police station open now",
      de: "nächste jetzt geöffnete Polizeiwache",
    },
  },
  {
    categoryId: "post_offices",
    split: "development",
    semantic: { en: "somewhere to mail a parcel", de: "irgendwo ein Paket verschicken" },
    structured: {
      en: "post office open Saturday near me",
      de: "samstags geöffnetes Postamt in meiner Nähe",
    },
  },
  {
    categoryId: "recycling",
    split: "test",
    semantic: { en: "where can I dispose of recyclables", de: "wo kann ich Wertstoffe entsorgen" },
    structured: {
      en: "nearest free glass and paper recycling point",
      de: "nächste kostenlose Sammelstelle für Glas und Papier",
    },
  },
  {
    categoryId: "restaurants",
    split: "development",
    semantic: { en: "somewhere to sit down for dinner", de: "irgendwo zum Abendessen hinsetzen" },
    structured: {
      en: "vegan restaurant for 2 open tonight",
      de: "heute Abend geöffnetes veganes Restaurant für 2",
    },
  },
  {
    categoryId: "schools",
    split: "development",
    semantic: {
      en: "a place where children receive lessons",
      de: "ein Ort, an dem Kinder Unterricht bekommen",
    },
    structured: { en: "nearest wheelchair accessible school", de: "nächste barrierefreie Schule" },
  },
  {
    categoryId: "shopping_malls",
    split: "development",
    semantic: {
      en: "many different shops under one roof",
      de: "viele verschiedene Geschäfte unter einem Dach",
    },
    structured: {
      en: "shopping centre open late with wheelchair access",
      de: "lange geöffnetes barrierefreies Einkaufszentrum",
    },
  },
  {
    categoryId: "supermarkets",
    split: "test",
    semantic: { en: "food shopping for the week", de: "Lebensmittel für die Woche einkaufen" },
    structured: {
      en: "cheap grocery store open now near me",
      de: "günstiger jetzt geöffneter Lebensmittelladen in meiner Nähe",
    },
  },
  {
    categoryId: "swimming",
    split: "test",
    semantic: { en: "somewhere to swim indoors", de: "irgendwo drinnen schwimmen" },
    structured: {
      en: "wheelchair accessible pool open tonight",
      de: "heute Abend geöffnetes barrierefreies Schwimmbad",
    },
  },
  {
    categoryId: "synagogues",
    split: "test",
    semantic: { en: "a place for Jewish prayer", de: "ein Ort für das jüdische Gebet" },
    structured: {
      en: "wheelchair accessible synagogue nearby",
      de: "barrierefreie Synagoge in der Nähe",
    },
  },
  {
    categoryId: "temples",
    split: "development",
    semantic: {
      en: "a Hindu or Buddhist place of worship",
      de: "ein hinduistischer oder buddhistischer Gebetsort",
    },
    structured: { en: "temple open today near me", de: "heute geöffneter Tempel in meiner Nähe" },
  },
  {
    categoryId: "toilets",
    split: "development",
    semantic: { en: "I need a bathroom", de: "ich brauche eine Toilette" },
    structured: {
      en: "free wheelchair accessible restroom nearby",
      de: "kostenlose barrierefreie Toilette in der Nähe",
    },
  },
  {
    categoryId: "transit",
    split: "development",
    semantic: { en: "where can I catch a bus or train", de: "wo kann ich Bus oder Bahn nehmen" },
    structured: {
      en: "nearest wheelchair accessible transit station",
      de: "nächste barrierefreie Haltestelle",
    },
  },
  {
    categoryId: "veterinarians",
    split: "test",
    semantic: { en: "my dog needs a doctor", de: "mein Hund braucht einen Arzt" },
    structured: {
      en: "veterinary clinic open now near me",
      de: "jetzt geöffnete Tierarztpraxis in meiner Nähe",
    },
  },
  {
    categoryId: "viewpoints",
    split: "test",
    semantic: { en: "somewhere with a panoramic view", de: "irgendwo mit Panoramablick" },
    structured: {
      en: "wheelchair accessible lookout close by",
      de: "barrierefreier Aussichtspunkt in der Nähe",
    },
  },
];

type NegativeSeed = readonly [query: string, lang: "en" | "de", split: "development" | "test"];

const NEGATIVE_SEEDS: Readonly<Record<SemanticNegativeFamily, readonly NegativeSeed[]>> = {
  "proper-name": [
    ["Cafe Central", "en", "test"],
    ["Hotel Adlon", "de", "test"],
    ["Park Inn", "en", "test"],
    ["Museum Island", "en", "test"],
    ["The Library Bar", "en", "test"],
    ["Bar Celona", "de", "test"],
    ["Central Pharmacy", "en", "development"],
    ["Berlin Story Bunker", "de", "development"],
    ["Aachener Tierpark", "de", "development"],
    ["Deutsche Bank", "de", "development"],
    ["Café Mozart", "de", "development"],
    ["Hotel Europa", "de", "development"],
    ["Green Park Hotel", "en", "development"],
    ["Museum Ludwig", "de", "development"],
    ["The Coffee House", "en", "development"],
    ["Apotheke am Markt", "de", "development"],
    ["Central Station Pub", "en", "development"],
    ["Tierarztpraxis Müller", "de", "development"],
    ["Riverside Cinema", "en", "development"],
    ["Bibliothek Altstadt", "de", "development"],
  ],
  brand: [
    ["Starbucks", "en", "test"],
    ["McDonald's", "en", "test"],
    ["IKEA", "de", "test"],
    ["Shell", "en", "test"],
    ["Aldi", "de", "test"],
    ["Lidl", "de", "test"],
    ["Burger King", "en", "development"],
    ["KFC", "en", "development"],
    ["Subway", "en", "development"],
    ["REWE", "de", "development"],
    ["Edeka", "de", "development"],
    ["dm", "de", "development"],
    ["Rossmann", "de", "development"],
    ["Aral", "de", "development"],
    ["BP", "en", "development"],
    ["Esso", "en", "development"],
    ["Hilton", "en", "development"],
    ["Marriott", "en", "development"],
    ["Decathlon", "de", "development"],
    ["H&M", "de", "development"],
  ],
  "address-code": [
    ["FRA", "en", "test"],
    ["BER", "de", "test"],
    ["52062 Aachen", "de", "test"],
    ["Friedrichstraße 43", "de", "test"],
    ["50.7753, 6.0839", "en", "test"],
    ["9F28+4V Aachen", "de", "test"],
    ["https://example.com/cafe", "en", "development"],
    ["A1 exit 12", "en", "development"],
    ["MUC", "de", "development"],
    ["10115 Berlin", "de", "development"],
    ["Oxford Street 10", "en", "development"],
    ["10 Downing Street", "en", "development"],
    ["48.1372 11.5756", "de", "development"],
    ["8FVC9G8F+5W", "en", "development"],
    ["http://localhost.test/place", "en", "development"],
    ["B27 Ausfahrt 4", "de", "development"],
    ["LHR", "en", "development"],
    ["50667 Köln", "de", "development"],
    ["Hauptstraße 8", "de", "development"],
    ["221B Baker Street", "en", "development"],
  ],
  ambiguous: [
    ["somewhere nice", "en", "test"],
    ["ein schöner Ort", "de", "test"],
    ["a good place", "en", "test"],
    ["irgendwo ruhig", "de", "test"],
    ["something fun", "en", "test"],
    ["etwas Interessantes", "de", "test"],
    ["cheap and close", "en", "development"],
    ["günstig und nah", "de", "development"],
    ["best rated nearby", "en", "development"],
    ["am besten bewertet", "de", "development"],
    ["somewhere cozy", "en", "development"],
    ["irgendwo gemütlich", "de", "development"],
    ["a popular spot", "en", "development"],
    ["ein beliebter Ort", "de", "development"],
    ["something for tonight", "en", "development"],
    ["etwas für heute Abend", "de", "development"],
    ["where should we go", "en", "development"],
    ["wohin sollen wir gehen", "de", "development"],
    ["surprise me", "en", "development"],
    ["überrasch mich", "de", "development"],
  ],
  "no-place-type": [
    ["open now", "en", "test"],
    ["jetzt geöffnet", "de", "test"],
    ["near me", "en", "test"],
    ["in meiner Nähe", "de", "test"],
    ["wheelchair accessible", "en", "test"],
    ["barrierefrei", "de", "test"],
    ["vegan and cheap", "en", "development"],
    ["vegan und günstig", "de", "development"],
    ["take me there", "en", "development"],
    ["bring mich dorthin", "de", "development"],
    ["what is around here", "en", "development"],
    ["was ist hier in der Umgebung", "de", "development"],
    ["open on Sunday", "en", "development"],
    ["sonntags geöffnet", "de", "development"],
    ["with wifi", "en", "development"],
    ["mit WLAN", "de", "development"],
    ["closest one", "en", "development"],
    ["das nächste", "de", "development"],
    ["free entry", "en", "development"],
    ["kostenloser Eintritt", "de", "development"],
  ],
  "unsupported-category": [
    ["where can I charge the car", "en", "test"],
    ["wo kann ich das Auto laden", "de", "test"],
    ["find a petrol station", "en", "test"],
    ["finde eine Tankstelle", "de", "test"],
    ["I need a car-sharing vehicle", "en", "test"],
    ["ich brauche ein Carsharing-Auto", "de", "test"],
    ["fast charger for my electric vehicle", "en", "development"],
    ["Schnelllader für mein Elektroauto", "de", "development"],
    ["somewhere to buy diesel", "en", "development"],
    ["irgendwo Diesel tanken", "de", "development"],
    ["borrow a shared car by the hour", "en", "development"],
    ["ein Auto stundenweise teilen", "de", "development"],
    ["electric car charging open now", "en", "development"],
    ["jetzt geöffnete Ladestation", "de", "development"],
    ["unleaded fuel nearby", "en", "development"],
    ["Benzin in meiner Nähe", "de", "development"],
    ["pick up a city car share", "en", "development"],
    ["ein Stadtteilauto abholen", "de", "development"],
    ["charge an EV overnight", "en", "development"],
    ["Elektroauto über Nacht laden", "de", "development"],
  ],
};

function positiveCases(): SemanticTaxonomyCaseV1[] {
  return POSITIVE_SEEDS.flatMap((seed) =>
    (["en", "de"] as const).flatMap((lang) => [
      {
        id: `positive:${seed.categoryId}:${lang}:semantic`,
        query: seed.semantic[lang],
        lang,
        split: seed.split,
        expected: {
          status: "category" as const,
          acceptableCategoryIds: seed.acceptable ?? [seed.categoryId],
        },
        strata: {
          kind: "semantic-only" as const,
          categoryFamily: seed.categoryId,
          conceptFamily: `category:${seed.categoryId}`,
          p0: false,
        },
        evidence: `This indirect request describes the ${seed.categoryId} product category without relying on its canonical English label.`,
      },
      {
        id: `positive:${seed.categoryId}:${lang}:structured`,
        query: seed.structured[lang],
        lang,
        split: seed.split,
        expected: {
          status: "category" as const,
          acceptableCategoryIds: seed.acceptable ?? [seed.categoryId],
        },
        strata: {
          kind: "structured" as const,
          categoryFamily: seed.categoryId,
          conceptFamily: `category:${seed.categoryId}`,
          p0: false,
        },
        evidence: `This request combines the ${seed.categoryId} category with a structured time, access, price, or proximity modifier.`,
      },
    ]),
  );
}

function negativeCases(): SemanticTaxonomyCaseV1[] {
  return Object.entries(NEGATIVE_SEEDS).flatMap(([family, seeds]) =>
    seeds.map(([query, lang, split], index) => ({
      id: `negative:${family}:${String(index + 1).padStart(2, "0")}`,
      query,
      lang,
      split,
      expected: { status: "abstain" as const, reasonFamily: family as SemanticNegativeFamily },
      strata: {
        kind: "negative" as const,
        categoryFamily: `negative:${family}`,
        conceptFamily: `negative:${family}:${String(index + 1).padStart(2, "0")}`,
        p0: ["proper-name", "brand", "address-code", "unsupported-category"].includes(family),
      },
      evidence: `This is a reviewed ${family} input that must not be coerced into a supported semantic category.`,
    })),
  );
}

export const CURATED_SEMANTIC_TAXONOMY_CASES_V1: readonly SemanticTaxonomyCaseV1[] = Object.freeze(
  [...positiveCases(), ...negativeCases()].map((item) => Object.freeze(item)),
);

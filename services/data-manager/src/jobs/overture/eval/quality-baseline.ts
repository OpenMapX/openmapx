/**
 * Human-reviewed anchors from Overture Places 2026-07-22.0.
 *
 * The labels were reviewed against the named real-world businesses and their
 * coordinates on 2026-07-28 and 2026-07-29. They cover multiple commercial
 * categories across a large German city, a medium German city, a rural German
 * town, and a non-German city. GERS ids are the stable assertions; names are
 * retained to make future re-labeling auditable.
 */
export const OVERTURE_QUALITY_BASELINE_RELEASE = "2026-07-22.0";

export interface OvertureQualityJudgment {
  gersId: string;
  name: string;
  relevant: boolean;
  /** Another judged GERS id for the same real-world place. */
  duplicateOf?: string;
  note?: string;
}

export interface OvertureQualityCase {
  id: string;
  description: string;
  /** Most-specific Geofabrik region containing the case. */
  region: string;
  category: string;
  bbox: { west: number; south: number; east: number; north: number };
  judgments: OvertureQualityJudgment[];
  minimumRelevantRecall: number;
  minimumResultCount: number;
  maximumKnownIrrelevantHits: number;
  maximumKnownDuplicateHits: number;
}

export const OVERTURE_QUALITY_BASELINE: readonly OvertureQualityCase[] = [
  {
    id: "aachen-centre-cafes",
    description: "Medium German city — cafés around Aachen cathedral and market",
    region: "europe/germany/nordrhein-westfalen",
    category: "cafes",
    bbox: { west: 6.08, south: 50.773, east: 6.09, north: 50.779 },
    judgments: [
      {
        gersId: "540af3e8-50fa-4ce4-af4a-0fbe932f1e60",
        name: "Café Middelberg",
        relevant: true,
      },
      {
        gersId: "7b9b6dd7-376b-41e3-bd44-00bccec514e7",
        name: "Lammerskötter im Hof",
        relevant: true,
      },
      {
        gersId: "f6197dc4-121d-4293-99c0-7c175a79a789",
        name: "Café van den Daele",
        relevant: true,
      },
      {
        gersId: "074eab43-e3ac-4387-8ba2-db2fad590dc9",
        name: "ALEX Aachen",
        relevant: true,
      },
      {
        gersId: "ae181ac1-4b3a-4ac7-adda-aada3cb663ed",
        name: "Cafe Extrablatt Aachen",
        relevant: true,
      },
      {
        gersId: "9aa4ca4d-7ba9-42d2-8836-da41f24b9eec",
        name: "Restaurant Magellan",
        relevant: false,
        note: "Restaurant mislabeled as coffee_shop",
      },
      {
        gersId: "56754cdb-f3fa-45da-81f4-40da5e262919",
        name: "Nespresso N-Point im Kaufhof",
        relevant: false,
        note: "Retail counter, not a café",
      },
    ],
    minimumRelevantRecall: 0.8,
    minimumResultCount: 30,
    maximumKnownIrrelevantHits: 2,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "aachen-centre-restaurants",
    description: "Medium German city — restaurants around Aachen cathedral",
    region: "europe/germany/nordrhein-westfalen",
    category: "restaurants",
    bbox: { west: 6.08, south: 50.772, east: 6.09, north: 50.779 },
    judgments: [
      {
        gersId: "df482c12-be57-4b1a-8771-978ef26e4ea7",
        name: "Domkeller",
        relevant: true,
      },
      {
        gersId: "d778aaef-acce-4ebd-84f2-aa6f4bba33e1",
        name: "Al Triangolo",
        relevant: true,
      },
      {
        gersId: "8a931f41-d5cd-45ed-893e-89ec67de69d3",
        name: "Aix Mediterrane",
        relevant: true,
      },
      {
        gersId: "c7c8aad5-d307-4c0a-8d35-6f2b711d6c0d",
        name: "Postwagen Zum Ratskeller",
        relevant: true,
      },
    ],
    minimumRelevantRecall: 0.75,
    minimumResultCount: 35,
    maximumKnownIrrelevantHits: 0,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "aachen-supermarkets",
    description: "Medium German city — supermarkets and grocery stores across central Aachen",
    region: "europe/germany/nordrhein-westfalen",
    category: "supermarkets",
    bbox: { west: 6.07, south: 50.765, east: 6.105, north: 50.79 },
    judgments: [
      {
        gersId: "26f4c066-fc3c-4439-a358-9214905f674b",
        name: "REWE",
        relevant: true,
      },
      {
        gersId: "1f03f3f2-8383-4491-a2a4-bf6f5e25fce8",
        name: "Netto",
        relevant: true,
      },
      {
        gersId: "9fbd9873-9e67-49cd-9c6e-3802202af79a",
        name: "go asia Supermarkt",
        relevant: true,
      },
      {
        gersId: "cf2fe3a2-f17f-4cd5-b492-7444cef4d129",
        name: "Basic Bio-Supermarkt",
        relevant: true,
      },
      {
        gersId: "4c18d0e6-2280-4dcd-b65c-92a04f588f61",
        name: "dm-drogerie markt Deutschland",
        relevant: false,
        note: "Drugstore classified as grocery_store, not a supermarket",
      },
    ],
    minimumRelevantRecall: 0.75,
    minimumResultCount: 15,
    maximumKnownIrrelevantHits: 1,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "aachen-pharmacies",
    description: "Medium German city — pharmacies around Aachen city centre",
    region: "europe/germany/nordrhein-westfalen",
    category: "pharmacies",
    bbox: { west: 6.08, south: 50.768, east: 6.098, north: 50.78 },
    judgments: [
      {
        gersId: "c9935b99-0328-4e96-95fd-40bd39305772",
        name: "Aeskulap Apotheke",
        relevant: true,
      },
      {
        gersId: "9a1d6898-8a77-4464-909c-5abd000535fa",
        name: "St. Georg-Apotheke",
        relevant: true,
      },
      {
        gersId: "fe153af4-0e2f-4dd5-9588-d45f30c2ebd9",
        name: "Hirsch-Apotheke",
        relevant: true,
      },
      {
        gersId: "fc76bc50-da9f-4abe-9a60-b0a52b3d3615",
        name: "Aquis Apotheke",
        relevant: true,
      },
      {
        gersId: "8b9ed93d-feb6-4773-bf29-114023baf124",
        name: "dm-drogerie markt",
        relevant: false,
        note: "Drugstore, not a licensed pharmacy",
      },
      {
        gersId: "2b0b2f08-ce04-4eb0-9582-d1a51fad3892",
        name: "Rossmann",
        relevant: false,
        note: "Drugstore, not a licensed pharmacy",
      },
      {
        gersId: "28513562-58da-4c47-89f5-f16075ce584d",
        name: "Müller Deutschland",
        relevant: false,
        note: "Drugstore, not a licensed pharmacy",
      },
    ],
    minimumRelevantRecall: 0.75,
    minimumResultCount: 20,
    maximumKnownIrrelevantHits: 3,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "aachen-hotels",
    description: "Medium German city — hotels from Aachen station to Quellenhof",
    region: "europe/germany/nordrhein-westfalen",
    category: "hotels",
    bbox: { west: 6.08, south: 50.767, east: 6.098, north: 50.783 },
    judgments: [
      {
        gersId: "a5bcd87a-6e76-4c51-93cc-3abdf071289d",
        name: "Mercure Hotel Aachen am Dom",
        relevant: true,
      },
      {
        gersId: "772497c5-dcb3-4b1b-ae4b-4d506ba18c92",
        name: "Aquis Grana Cityhotel",
        relevant: true,
      },
      {
        gersId: "602e55fb-33f1-41ac-953d-a7d73d481dda",
        name: "Hotel Motel One Aachen",
        relevant: true,
      },
      {
        gersId: "c63fcbd4-3d9f-4e84-9a53-ebe67d2ab32e",
        name: "Novotel Aachen City",
        relevant: true,
      },
    ],
    minimumRelevantRecall: 0.75,
    minimumResultCount: 25,
    maximumKnownIrrelevantHits: 0,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "aachen-fuel",
    description: "Medium German city — fuel stations across Aachen",
    region: "europe/germany/nordrhein-westfalen",
    category: "fuel",
    bbox: { west: 6.065, south: 50.76, east: 6.11, north: 50.795 },
    judgments: [
      {
        gersId: "798188a3-e06f-4dd1-a807-a5ad20fd177e",
        name: "SB Tankstelle",
        relevant: true,
      },
      {
        gersId: "8216946e-5577-4bf9-bd35-3274a9b11890",
        name: "Shell",
        relevant: true,
      },
      {
        gersId: "f9a06a27-fdf9-4533-a52f-51fabf4f11ec",
        name: "Aral",
        relevant: true,
      },
      {
        gersId: "9e4ad950-0249-4fbc-9169-82680066fb9f",
        name: "Esso",
        relevant: true,
      },
    ],
    minimumRelevantRecall: 0.75,
    minimumResultCount: 10,
    maximumKnownIrrelevantHits: 0,
    maximumKnownDuplicateHits: 0,
  },
  {
    id: "berlin-mitte-cafes",
    description: "Large German city — cafés from Brandenburg Gate to Potsdamer Platz",
    region: "europe/germany/berlin",
    category: "cafes",
    bbox: { west: 13.37, south: 52.51, east: 13.39, north: 52.52 },
    judgments: [
      {
        gersId: "f823fc26-d04c-4558-9686-f9f24727a131",
        name: "Adlon To Go Coffee Shop",
        relevant: true,
      },
      {
        gersId: "bee4f160-5bf8-446f-bc32-e95291782339",
        name: "Starbucks",
        relevant: true,
      },
      {
        gersId: "b998e703-8018-4866-9c03-24017f35bfc5",
        name: "Dunkin'",
        relevant: true,
      },
      {
        gersId: "869b880a-e3f9-40ef-8025-6dce783d6b97",
        name: "Café Lebensart am Brandenburger Tor",
        relevant: true,
      },
      {
        gersId: "133f6f56-d3f9-4241-8d55-c6bb0cf007df",
        name: "The Bike Café",
        relevant: true,
      },
      {
        gersId: "311992c2-4d9a-425d-a613-c22c9838dfa2",
        name: "MAREDO Steakhouse Berlin Unter den Linden",
        relevant: false,
        note: "Steakhouse mislabeled as coffee_shop",
      },
      {
        gersId: "9552f672-4367-41f0-9821-7d2e79372f3f",
        name: "ZDF Cafe",
        relevant: true,
      },
      {
        gersId: "4830a3f4-7cea-4d4c-bd04-3f732e4128f6",
        name: "ZDF Cafe",
        relevant: true,
        duplicateOf: "9552f672-4367-41f0-9821-7d2e79372f3f",
      },
    ],
    minimumRelevantRecall: 0.8,
    minimumResultCount: 35,
    maximumKnownIrrelevantHits: 1,
    maximumKnownDuplicateHits: 1,
  },
  {
    id: "monschau-centre-cafes",
    description: "Rural Germany — cafés in Monschau old town",
    region: "europe/germany/nordrhein-westfalen",
    category: "cafes",
    bbox: { west: 6.235, south: 50.55, east: 6.25, north: 50.56 },
    judgments: [
      {
        gersId: "060cb5a2-5a64-405e-b52a-f7cb774a673a",
        name: "Cafe Kaulard",
        relevant: true,
      },
      {
        gersId: "a7526636-8c12-4c7e-bcc3-1fcbe52ab25a",
        name: "Weekend",
        relevant: true,
      },
      {
        gersId: "e5c9adca-bc07-4dd6-a632-fc44af211394",
        name: "Cafe Hirsch Oebel",
        relevant: true,
      },
      {
        gersId: "9fc1bad4-08d4-4189-9ca7-d5851f83b196",
        name: "Rur Café",
        relevant: true,
      },
      {
        gersId: "5f797b2a-d0a9-4784-bb2c-0f3c22f80704",
        name: "Schokoladen Café Hüftgold, Monschau",
        relevant: true,
      },
      {
        gersId: "956e6294-de9a-44be-ace0-ad4a8b4b57f7",
        name: "Cafe Am Roten Haus",
        relevant: true,
      },
      {
        gersId: "338f6a6a-e608-4e96-bd35-04dc28deb1a3",
        name: "Elke Klein Konditorei Café am",
        relevant: true,
        duplicateOf: "956e6294-de9a-44be-ace0-ad4a8b4b57f7",
        note: "Same coordinates and business as Cafe Am Roten Haus",
      },
    ],
    minimumRelevantRecall: 0.8,
    minimumResultCount: 6,
    maximumKnownIrrelevantHits: 0,
    maximumKnownDuplicateHits: 1,
  },
  {
    id: "maastricht-centre-cafes",
    description: "Non-German city — cafés around Maastricht Vrijthof",
    region: "europe/netherlands",
    category: "cafes",
    bbox: { west: 5.68, south: 50.845, east: 5.7, north: 50.855 },
    judgments: [
      {
        gersId: "2d7f99ae-89f6-4dcf-9a22-7eea1b045e41",
        name: "Coffeelovers Dominicanen",
        relevant: true,
      },
      {
        gersId: "26cc7240-9a7a-4791-a0eb-22cd8187c7c2",
        name: "Oila",
        relevant: true,
      },
      {
        gersId: "1d87933b-7399-43df-8747-628c597f8250",
        name: "Grand Cafe Nieuw Bruin",
        relevant: true,
      },
      {
        gersId: "7fd01d58-c61b-4c05-b638-8b6fc8cf170b",
        name: "Naovenant",
        relevant: true,
      },
      {
        gersId: "9b5cd6b0-cf9c-476d-bf59-3a39d8901eb0",
        name: "Café Hallo Mestreeg",
        relevant: true,
      },
      {
        gersId: "f9c05d38-3cda-4357-b4d5-21bcf44aad1a",
        name: "Taco Mundo Maastricht",
        relevant: false,
        note: "Takeaway restaurant mislabeled as cafe",
      },
    ],
    minimumRelevantRecall: 0.8,
    minimumResultCount: 35,
    maximumKnownIrrelevantHits: 1,
    maximumKnownDuplicateHits: 0,
  },
] as const;

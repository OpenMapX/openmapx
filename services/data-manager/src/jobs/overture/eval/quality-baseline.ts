/**
 * Human-reviewed anchors from Overture Places 2026-07-22.0.
 *
 * The labels were reviewed against the named real-world businesses and their
 * coordinates on 2026-07-28. They intentionally cover a large German city, a
 * medium German city, a rural German town, and a non-German city. GERS ids are
 * the stable assertions; names are retained to make future re-labeling auditable.
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

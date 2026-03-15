import type { PlaceFact } from "@openmapx/core";
import type { EnrichmentResult, EnrichmentSource } from "./types";

const HEADERS = {
  "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)",
  Accept: "application/json",
};

// Wikidata API types (minimal)
type TimeValue = { time: string; precision: number };
type QuantityValue = { amount: string };
type EntityValue = { id: string };
type DataValue =
  | { type: "time"; value: TimeValue }
  | { type: "quantity"; value: QuantityValue }
  | { type: "wikibase-entityid"; value: EntityValue }
  | { type: string; value: unknown };

type Snak = { snaktype: string; datavalue?: DataValue };
type Claim = { mainsnak: Snak; rank: "preferred" | "normal" | "deprecated" };

type WdEntity = {
  descriptions?: { en?: { value: string } };
  claims?: Record<string, Claim[]>;
  sitelinks?: { enwiki?: { title: string } };
};

// Property config — each entry describes one Wikidata property to extract
type PropConfig =
  | { id: string; label: string; type: "time" }
  | { id: string; label: string; type: "quantity" }
  | { id: string; label: string; type: "item" };

const PROPS: PropConfig[] = [
  // Dates
  { id: "P571", label: "Founded", type: "time" },
  { id: "P576", label: "Dissolved", type: "time" },
  { id: "P1619", label: "Opened", type: "time" },
  // Numbers
  { id: "P1082", label: "Population", type: "quantity" },
  { id: "P1083", label: "Capacity", type: "quantity" },
  { id: "P1128", label: "Employees", type: "quantity" },
  { id: "P2196", label: "Students enrolled", type: "quantity" },
  { id: "P3872", label: "Beds", type: "quantity" },
  // Items (resolved via a second batch call)
  { id: "P84", label: "Architect", type: "item" },
  { id: "P112", label: "Founder", type: "item" },
  { id: "P149", label: "Architectural style", type: "item" },
  { id: "P1435", label: "Heritage designation", type: "item" },
  { id: "P138", label: "Named after", type: "item" },
  { id: "P466", label: "Occupant", type: "item" },
];

// Helpers
/** Converts a Wikimedia Commons filename to a thumbnail URL. */
function commonsUrl(filename: string, width = 800): string {
  const encoded = encodeURIComponent(filename.replace(/ /g, "_"));
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encoded}?width=${width}`;
}

/** Returns the best (preferred > normal) non-deprecated claim for a property, or undefined. */
function bestClaim(claims: Record<string, Claim[]> | undefined, prop: string): Claim | undefined {
  const list = claims?.[prop];
  if (!list?.length) return undefined;
  return (
    list.find((c) => c.rank === "preferred" && c.mainsnak.snaktype === "value") ??
    list.find((c) => c.rank === "normal" && c.mainsnak.snaktype === "value")
  );
}

/** All non-deprecated claims for a property (for multi-value fields like architects). */
function activeClaims(claims: Record<string, Claim[]> | undefined, prop: string): Claim[] {
  return (claims?.[prop] ?? []).filter(
    (c) => c.rank !== "deprecated" && c.mainsnak.snaktype === "value",
  );
}

function formatYear(tv: TimeValue): string {
  // Wikidata time: "+1870-01-01T00:00:00Z" or "-0356-01-01T00:00:00Z"
  const bce = tv.time.startsWith("-");
  const year = Number.parseInt(tv.time.slice(bce ? 1 : 1, bce ? 5 : 5), 10);
  return bce ? `${year} BCE` : String(year);
}

function formatQuantity(qv: QuantityValue): string {
  const n = Math.round(Number.parseFloat(qv.amount));
  return n.toLocaleString("en");
}

// Enricher
export const wikidataEnricher: EnrichmentSource = {
  name: "wikidata",

  async enrich(osmTags) {
    const qid = osmTags.wikidata;
    if (!qid) return null;

    const url = new URL("https://www.wikidata.org/w/api.php");
    url.searchParams.set("action", "wbgetentities");
    url.searchParams.set("ids", qid);
    url.searchParams.set("props", "claims|descriptions|sitelinks");
    url.searchParams.set("languages", "en");
    url.searchParams.set("sitefilter", "enwiki");
    url.searchParams.set("format", "json");

    const res = await fetch(url.toString(), {
      headers: HEADERS,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { entities?: Record<string, WdEntity> };
    const entity = data.entities?.[qid];
    if (!entity) return null;

    const result: EnrichmentResult = {};

    // Description
    const desc = entity.descriptions?.en?.value;
    if (desc) result.description = desc.charAt(0).toUpperCase() + desc.slice(1);

    // Wikipedia URL
    const wikiTitle = entity.sitelinks?.enwiki?.title;
    if (wikiTitle) {
      result.wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, "_"))}`;
    }

    // Main image (P18)
    const p18 = bestClaim(entity.claims, "P18");
    if (p18?.mainsnak.datavalue?.type === "string") {
      result.photos = [
        {
          url: commonsUrl(p18.mainsnak.datavalue.value as string),
          attribution: "© Wikimedia Commons (CC BY-SA)",
        },
      ];
    }

    // External platform IDs — used downstream to build direct review links
    const EXTERNAL_ID_PROPS: Record<string, string> = {
      P2397: "yelp", // Yelp business slug
      P7566: "foursquare", // Foursquare venue UUID
    };
    const externalIds: Record<string, string> = {};
    for (const [prop, key] of Object.entries(EXTERNAL_ID_PROPS)) {
      const claim = bestClaim(entity.claims, prop);
      if (claim?.mainsnak.datavalue?.type === "string") {
        externalIds[key] = claim.mainsnak.datavalue.value as string;
      }
    }
    if (Object.keys(externalIds).length > 0) result.externalIds = externalIds;

    // Structured facts
    const facts: PlaceFact[] = [];
    const itemsToResolve: { label: string; ids: string[] }[] = [];

    for (const prop of PROPS) {
      if (prop.type === "time") {
        const claim = bestClaim(entity.claims, prop.id);
        if (claim?.mainsnak.datavalue?.type === "time") {
          facts.push({
            label: prop.label,
            value: formatYear(claim.mainsnak.datavalue.value as TimeValue),
          });
        }
      } else if (prop.type === "quantity") {
        const claim = bestClaim(entity.claims, prop.id);
        if (claim?.mainsnak.datavalue?.type === "quantity") {
          facts.push({
            label: prop.label,
            value: formatQuantity(claim.mainsnak.datavalue.value as QuantityValue),
          });
        }
      } else if (prop.type === "item") {
        const ids = activeClaims(entity.claims, prop.id)
          .filter((c) => c.mainsnak.datavalue?.type === "wikibase-entityid")
          .map((c) => (c.mainsnak.datavalue?.value as EntityValue).id);
        if (ids.length) itemsToResolve.push({ label: prop.label, ids });
      }
    }

    // Batch-resolve item labels in a single extra API call
    if (itemsToResolve.length > 0) {
      const allIds = [...new Set(itemsToResolve.flatMap((i) => i.ids))];
      try {
        const labelUrl = new URL("https://www.wikidata.org/w/api.php");
        labelUrl.searchParams.set("action", "wbgetentities");
        labelUrl.searchParams.set("ids", allIds.join("|"));
        labelUrl.searchParams.set("props", "labels");
        labelUrl.searchParams.set("languages", "en");
        labelUrl.searchParams.set("format", "json");

        const labelRes = await fetch(labelUrl.toString(), {
          headers: HEADERS,
          signal: AbortSignal.timeout(3000),
        });
        if (labelRes.ok) {
          const labelData = (await labelRes.json()) as {
            entities?: Record<string, { labels?: { en?: { value: string } } }>;
          };
          for (const { label, ids } of itemsToResolve) {
            const resolved = ids
              .map((id) => labelData.entities?.[id]?.labels?.en?.value)
              .filter(Boolean) as string[];
            if (resolved.length) facts.push({ label, value: resolved.join(", ") });
          }
        }
      } catch {
        // Label resolution failed — silently skip item facts
      }
    }

    if (facts.length) result.facts = facts;

    return Object.keys(result).length > 0 ? result : null;
  },
};

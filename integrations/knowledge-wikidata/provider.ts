import {
  fetchCommonsMetadata,
  fetchJson,
  type KnowledgeProvider,
  type KnowledgeResult,
  type PlaceFact,
} from "@openmapx/core";

const HEADERS = {
  Accept: "application/json",
};

// Wikidata API types (minimal)
type TimeValue = { time: string; precision: number };
type QuantityValue = { amount: string; unit?: string };
type EntityValue = { id: string };
type DataValue =
  | { type: "time"; value: TimeValue }
  | { type: "quantity"; value: QuantityValue }
  | { type: "wikibase-entityid"; value: EntityValue }
  | { type: string; value: unknown };

type Snak = { snaktype: string; datavalue?: DataValue };
type Claim = { mainsnak: Snak; rank: "preferred" | "normal" | "deprecated" };

type WdEntity = {
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
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
  // Counts (dimensionless)
  { id: "P1082", label: "Population", type: "quantity" },
  { id: "P1083", label: "Capacity", type: "quantity" },
  { id: "P1128", label: "Employees", type: "quantity" },
  { id: "P2196", label: "Students enrolled", type: "quantity" },
  { id: "P6801", label: "Beds", type: "quantity" },
  // Measurements (with units)
  { id: "P2046", label: "Area", type: "quantity" },
  { id: "P2044", label: "Elevation", type: "quantity" },
  { id: "P2048", label: "Height", type: "quantity" },
  { id: "P2043", label: "Length", type: "quantity" },
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

const UNIT_LABELS: Record<string, string> = {
  Q11573: "m",
  Q828224: "km",
  Q712226: "km²",
  Q25343: "m²",
  Q35852: "ha",
  Q3710: "ft",
  Q253276: "mi",
};

function formatQuantity(qv: QuantityValue, lang = "en"): string {
  const n = Math.round(Number.parseFloat(qv.amount));
  const formatted = n.toLocaleString(lang);
  if (qv.unit && qv.unit !== "1") {
    const unitId = qv.unit.replace("http://www.wikidata.org/entity/", "");
    const label = UNIT_LABELS[unitId];
    if (label) return `${formatted} ${label}`;
  }
  return formatted;
}

export const wikidataSource: KnowledgeProvider = {
  name: "wikidata",

  async lookup(osmTags, lang?) {
    const qid = osmTags.wikidata;
    if (!qid) return null;

    const effectiveLang = lang ?? "en";
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.searchParams.set("action", "wbgetentities");
    url.searchParams.set("ids", qid);
    url.searchParams.set("props", "claims|descriptions|sitelinks");
    url.searchParams.set("languages", effectiveLang);
    url.searchParams.set("sitefilter", `${effectiveLang}wiki`);
    url.searchParams.set("format", "json");

    const data = await fetchJson<{ entities?: Record<string, WdEntity> }>(url.toString(), {
      headers: HEADERS,
      timeoutMs: 4000,
      nullOnError: true,
    });
    if (!data) return null;
    const entity = data.entities?.[qid];
    if (!entity) return null;

    const result: KnowledgeResult = {};

    // Short Wikidata description (tagline for Overview tab)
    const desc = entity.descriptions?.[effectiveLang]?.value;
    if (desc) {
      result.description = desc.charAt(0).toUpperCase() + desc.slice(1);
    }

    // Wikipedia URL + extract (longer summary for Info tab)
    const wikiTitle = entity.sitelinks?.[`${effectiveLang}wiki`]?.title;
    if (wikiTitle) {
      const encodedTitle = encodeURIComponent(wikiTitle.replace(/ /g, "_"));
      result.wikipediaUrl = `https://${effectiveLang}.wikipedia.org/wiki/${encodedTitle}`;

      const wpData = await fetchJson<{ extract?: string }>(
        `https://${effectiveLang}.wikipedia.org/api/rest_v1/page/summary/${encodedTitle}`,
        { timeoutMs: 3000, headers: { Accept: "application/json" }, nullOnError: true },
      );
      if (wpData?.extract) {
        result.wikipediaExtract = wpData.extract;
        result.wikipediaExtractSource = ["knowledge-wikidata", "knowledge-wikipedia"];
      }
    }

    // Main image (P18) — fetch rich metadata from Commons
    const p18 = bestClaim(entity.claims, "P18");
    if (p18?.mainsnak.datavalue?.type === "string") {
      const p18Filename = p18.mainsnak.datavalue.value as string;
      const metadata = await fetchCommonsMetadata([p18Filename]);
      const richPhoto = metadata.get(p18Filename.replace(/_/g, " "));
      if (richPhoto) {
        result.photos = [richPhoto];
      } else {
        // Fallback if metadata fetch fails
        result.photos = [
          {
            url: commonsUrl(p18Filename),
            source: "wikimedia",
            pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p18Filename.replace(/ /g, "_"))}`,
          },
        ];
      }
    }

    // External platform IDs — used downstream to build direct review links
    const EXTERNAL_ID_PROPS: Record<string, string> = {
      P3108: "yelp", // Yelp business ID
      P3134: "tripadvisor", // Tripadvisor location ID
      P3749: "google_maps", // Google Maps CID
      P2464: "foursquare", // Foursquare venue ID
      P2003: "instagram", // Instagram username
      P2013: "facebook", // Facebook page/profile ID
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
            value: formatQuantity(claim.mainsnak.datavalue.value as QuantityValue, effectiveLang),
          });
        }
      } else if (prop.type === "item") {
        const ids = activeClaims(entity.claims, prop.id)
          .map((c) => {
            const value = c.mainsnak.datavalue;
            return value?.type === "wikibase-entityid"
              ? (value.value as EntityValue).id
              : undefined;
          })
          .filter((id): id is string => id !== undefined);
        if (ids.length) itemsToResolve.push({ label: prop.label, ids });
      }
    }

    // Batch-resolve item labels in a single extra API call
    if (itemsToResolve.length > 0) {
      const allIds = [...new Set(itemsToResolve.flatMap((i) => i.ids))];
      const labelUrl = new URL("https://www.wikidata.org/w/api.php");
      labelUrl.searchParams.set("action", "wbgetentities");
      labelUrl.searchParams.set("ids", allIds.join("|"));
      labelUrl.searchParams.set("props", "labels");
      labelUrl.searchParams.set("languages", effectiveLang);
      labelUrl.searchParams.set("format", "json");

      const labelData = await fetchJson<{
        entities?: Record<string, { labels?: Record<string, { value: string }> }>;
      }>(labelUrl.toString(), {
        timeoutMs: 3000,
        headers: { Accept: "application/json" },
        nullOnError: true,
      });
      if (labelData) {
        for (const { label, ids } of itemsToResolve) {
          const resolved = ids
            .map((id) => labelData.entities?.[id]?.labels?.[effectiveLang]?.value)
            .filter(Boolean) as string[];
          if (resolved.length) facts.push({ label, value: resolved.join(", ") });
        }
      }
    }

    if (facts.length) result.facts = facts;

    return Object.keys(result).length > 0 ? result : null;
  },
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvChargingConnector, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it } from "vitest";
import { parseDelimited, rowsToObjects } from "../csv.js";
import { parseDeBnetzaCsv } from "../de-bnetza-parser.js";
import { createPayloadStationMapper } from "../payload-station.js";
import {
  cleanString,
  connector,
  joinAddress,
  parseInteger,
  parseLocalizedNumber,
  splitList,
} from "../utils.js";

// Pre-migration reference implementation, lifted verbatim from
// integrations/ev-charging/providers/bnetza.ts as it stood before the
// poi-ingest migration, with the source id and station-id prefix updated to
// the current "de-bnetza" naming. Everything else — name, coordinates,
// address, operator, status, usageType, usageCost, openingHours, access,
// paymentMethods, connectors, updatedAt, sourceUrl — must be byte-identical.
const REFERENCE_DATASET_PAGE_URL =
  "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/DownloadundKontakt.html";

type EvChargingStatus = NonNullable<EvChargingStation["status"]>;

function refStatusFromText(value: string | undefined): EvChargingStatus {
  const lower = value?.toLowerCase() ?? "";
  if (lower.includes("außer") || lower.includes("ausser")) return "not-operational";
  if (lower.includes("nicht")) return "not-operational";
  if (lower.includes("planung") || lower.includes("bau")) return "planned";
  if (lower.includes("betrieb")) return "operational";
  return "unknown";
}

function refRowValue(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cleanString(row[key]);
    if (value) return value;
  }
  return undefined;
}

function refGetConnectors(row: Record<string, string>): EvChargingConnector[] {
  const connectors: EvChargingConnector[] = [];
  for (let i = 1; i <= 6; i++) {
    const types = splitList(refRowValue(row, `Steckertypen${i}`));
    const powers = splitList(refRowValue(row, `Nennleistung Stecker${i}`));
    const evseIds = splitList(refRowValue(row, `EVSE-ID${i}`));
    for (let j = 0; j < types.length; j++) {
      connectors.push(
        connector({
          type: types[j],
          powerKw: parseLocalizedNumber(powers[j] ?? powers[0]),
          quantity: 1,
          reference: evseIds[j] ?? evseIds[0],
        }),
      );
    }
  }
  if (connectors.length === 0) {
    const quantity = parseInteger(refRowValue(row, "Anzahl Ladepunkte"));
    const powerKw = parseLocalizedNumber(refRowValue(row, "Nennleistung Ladeeinrichtung [kW]"));
    if (quantity || powerKw) {
      connectors.push(connector({ type: "Unknown", powerKw, quantity }));
    }
  }
  return connectors;
}

function refOpeningHours(row: Record<string, string>): string | undefined {
  const raw = refRowValue(row, "Öffnungszeiten");
  if (raw === "247") return "24/7";
  const days = refRowValue(row, "Öffnungszeiten: Wochentage");
  const times = refRowValue(row, "Öffnungszeiten: Tageszeiten");
  if (days && times) return `${days}: ${times}`;
  return raw;
}

function refRowToStation(row: Record<string, string>): EvChargingStation | null {
  const id = refRowValue(row, "Ladeeinrichtungs-ID");
  const lat = parseLocalizedNumber(refRowValue(row, "Breitengrad"));
  const lng = parseLocalizedNumber(refRowValue(row, "Längengrad"));
  if (!id || lat === undefined || lng === undefined) return null;
  const operator = refRowValue(row, "Betreiber");
  const displayName =
    refRowValue(row, "Anzeigename (Karte)") ??
    refRowValue(row, "Standortbezeichnung") ??
    operator ??
    "EV Charging Station";
  const paymentMethods = splitList(refRowValue(row, "Bezahlsysteme"));
  return {
    id: `de-bnetza:${id}`,
    sources: ["de-bnetza"],
    sourceItemIds: [`de-bnetza:${id}`],
    name: displayName,
    coordinates: [lng, lat],
    address: {
      line1: joinAddress([refRowValue(row, "Straße"), refRowValue(row, "Hausnummer")]),
      town: refRowValue(row, "Ort"),
      state: refRowValue(row, "Bundesland"),
      postcode: refRowValue(row, "Postleitzahl"),
      country: "Germany",
    },
    operator: operator ? { name: operator } : undefined,
    status: refStatusFromText(refRowValue(row, "Status")),
    usageType: refRowValue(row, "Art der Ladeeinrichtung"),
    usageCost: paymentMethods.includes("Kostenlos") ? "Free" : undefined,
    openingHours: refOpeningHours(row),
    access: refRowValue(row, "Informationen zum Parkraum"),
    paymentMethods: paymentMethods.length > 0 ? paymentMethods : undefined,
    connectors: refGetConnectors(row),
    updatedAt: refRowValue(row, "Inbetriebnahmedatum"),
    sourceUrl: REFERENCE_DATASET_PAGE_URL,
  };
}

function runReferenceParse(buffer: Buffer): EvChargingStation[] {
  const text = new TextDecoder("windows-1252").decode(buffer);
  const rows = parseDelimited(text, ";");
  const headerIndex = rows.findIndex((row) => row[0] === "Ladeeinrichtungs-ID");
  if (headerIndex < 0) return [];
  return rowsToObjects(rows, headerIndex)
    .map(refRowToStation)
    .filter((s): s is EvChargingStation => Boolean(s));
}

const mapDeBnetzaStatic = createPayloadStationMapper({
  sourceId: "de-bnetza",
  stationIdPrefix: "de-bnetza:",
});

function runMigrationParse(buffer: Buffer): EvChargingStation[] {
  const out: EvChargingStation[] = [];
  for (const row of parseDeBnetzaCsv(buffer)) {
    out.push(mapDeBnetzaStatic(row.poiId, row.payload));
  }
  return out;
}

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "bnetza-sample.csv");

describe("bnetza parser+mapper equivalence to pre-migration in-memory parser", () => {
  it("produces stations whose only difference is the namespaced source id", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const reference = runReferenceParse(buffer);
    const migrated = runMigrationParse(buffer);

    expect(migrated).toHaveLength(reference.length);

    for (let i = 0; i < reference.length; i++) {
      // Field-by-field assertion keeps the failure message readable when a
      // shape regression slips through.
      const ref = reference[i];
      const got = migrated[i];
      expect(got, `row ${i}: id mismatch`).toMatchObject({ id: ref.id });
      expect(got.sources, `row ${i}: sources mismatch`).toEqual(ref.sources);
      expect(got.sourceItemIds, `row ${i}: sourceItemIds mismatch`).toEqual(ref.sourceItemIds);
      expect(got.coordinates, `row ${i}: coordinates mismatch`).toEqual(ref.coordinates);
      expect(got.name, `row ${i}: name mismatch`).toBe(ref.name);
      expect(got.status, `row ${i}: status mismatch`).toBe(ref.status);
      expect(got.usageType, `row ${i}: usageType mismatch`).toBe(ref.usageType);
      expect(got.usageCost, `row ${i}: usageCost mismatch`).toBe(ref.usageCost);
      expect(got.openingHours, `row ${i}: openingHours mismatch`).toBe(ref.openingHours);
      expect(got.access, `row ${i}: access mismatch`).toBe(ref.access);
      expect(got.paymentMethods, `row ${i}: paymentMethods mismatch`).toEqual(ref.paymentMethods);
      expect(got.operator, `row ${i}: operator mismatch`).toEqual(ref.operator);
      expect(got.address, `row ${i}: address mismatch`).toEqual(ref.address);
      expect(got.connectors, `row ${i}: connectors mismatch`).toEqual(ref.connectors);
      expect(got.updatedAt, `row ${i}: updatedAt mismatch`).toBe(ref.updatedAt);
      expect(got.sourceUrl, `row ${i}: sourceUrl mismatch`).toBe(ref.sourceUrl);
    }
  });

  it("emits the exact same set of station ids the reference impl would", () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const refIds = runReferenceParse(buffer).map((s) => s.id);
    const migIds = runMigrationParse(buffer).map((s) => s.id);
    expect(migIds).toEqual(refIds);
  });
});

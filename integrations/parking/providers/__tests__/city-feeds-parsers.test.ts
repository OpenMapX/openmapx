import { describe, expect, it } from "vitest";
import { parseBambergDeBundled } from "../bamberg-de-parser.js";
import { parseBielefeldDeBundled } from "../bielefeld-de-parser.js";
import { parseBraunschweigDeBundled } from "../braunschweig-de-parser.js";
import { parseBremenDeStatic } from "../bremen-de-parser.js";
import { parseDuesseldorfDeBundled } from "../duesseldorf-de-parser.js";
import { parsePotsdamDeBundled } from "../potsdam-de-parser.js";
import { parseSalzburgAtBundled } from "../salzburg-at-parser.js";
import { parseTrierDeBundled } from "../trier-de-parser.js";

/**
 * Smoke tests for the eight direct city/operator parking feeds (Braunschweig,
 * Bremen, Düsseldorf, Salzburg, Bielefeld, Bamberg, Trier, Potsdam).
 *
 * Each test uses a hand-trimmed fixture that mirrors the actual upstream
 * shape (verified by `curl` at the time of authoring). The goal is not full
 * field coverage — it's catching shape bugs (wrong path to id/coords, wrong
 * delimiter, wrong regex) that would silently drop every row.
 */

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };
const ctx = { log };

function buf(str: string): Buffer {
  return Buffer.from(str, "utf-8");
}

describe("parseBraunschweigDeBundled", () => {
  it("emits a static row + live state per feature, indexed by feature.id", async () => {
    const fixture = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "26058262cf",
          geometry: { type: "Point", coordinates: [10.518574, 52.266929] },
          properties: {
            id: "26058262cf",
            name: "Parkhaus Lange Str. Nord",
            title: "Parkhaus Lange Str. Nord",
            type: "parking",
            openingState: "open",
            capacity: 150,
            free: 76,
            occupancyRate: 49,
            timestamp: "2026-05-27T15:38:09+02:00",
          },
        },
      ],
    });
    const out = await parseBraunschweigDeBundled(buf(fixture), ctx);
    expect(out.static).toHaveLength(1);
    expect(out.static[0].poiId).toBe("26058262cf");
    expect(out.static[0].payload.name).toBe("Parkhaus Lange Str. Nord");
    expect(out.static[0].payload.capacity).toBe(150);
    expect(out.live.get("26058262cf")?.freeSpaces).toBe(76);
    expect(out.live.get("26058262cf")?.state).toBe("open");
  });
});

describe("parseBremenDeStatic", () => {
  it("emits one row per VMZ feature with maxHeight in centimeters", () => {
    const fixture = JSON.stringify({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "EPSG:4326" } },
      features: [
        {
          type: "Feature",
          id: "poi-vmz-hb-32",
          geometry: { type: "Point", coordinates: [8.81, 53.08] },
          properties: {
            id: "poi-vmz-hb-32",
            name: "Am Bahnhof",
            title: "Am Bahnhof",
            externalId: "PH10",
            height_restriction: "1,95 m",
          },
        },
      ],
    });
    const rows = parseBremenDeStatic(buf(fixture));
    expect(rows).toHaveLength(1);
    expect(rows[0].poiId).toBe("poi-vmz-hb-32");
    expect(rows[0].payload.name).toBe("Am Bahnhof");
    expect(rows[0].payload.maxHeight).toBe(195);
  });
});

describe("parseDuesseldorfDeBundled", () => {
  it("derives freeSpaces from kurzparkermax - kurzparkerbelegt and maps status=1 → open", async () => {
    const fixture = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "Parkhaeuser.1",
          geometry: { type: "Point", coordinates: [6.7764, 51.2301] },
          properties: {
            pid: 1,
            name: "PH 01 - Ratinger Tor",
            kurzparkermax: 300,
            kurzparkerbelegt: 187,
            status: 1,
            daysecto_belegung: "2026-05-27T13:42:18Z",
            vti_anschrift: "Ratinger Str 1<br>40213 Düsseldorf",
            durchfahrtshoehe: 2.1,
          },
        },
      ],
    });
    const out = await parseDuesseldorfDeBundled(buf(fixture), ctx);
    expect(out.static[0].poiId).toBe("1");
    expect(out.static[0].payload.capacity).toBe(300);
    expect(out.static[0].payload.maxHeight).toBe(210);
    expect(out.static[0].payload.address).toBe("Ratinger Str 1, 40213 Düsseldorf");
    expect(out.live.get("1")?.freeSpaces).toBe(113);
    expect(out.live.get("1")?.state).toBe("open");
  });
});

describe("parseSalzburgAtBundled", () => {
  it("parses 'NNN (PP%)' into freeSpaces when FREIE_PLAETZE_STATUS=1, skips '=0", async () => {
    const fixture = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "parkplatz.22101",
          geometry: { type: "Point", coordinates: [13.0378, 47.7974] },
          properties: {
            ID: 22101,
            BEZEICHNUNG: "Altstadtgarage A",
            ADRESSE: "Hildmannplatz",
            TYP: "Garage/Parkhaus",
            FREIE_PLAETZE: "207 (34%)",
            FREIE_PLAETZE_STATUS: 1,
            BELEGUNG_AKTUALISIERT: "27.5.2026 15:48",
          },
        },
        {
          type: "Feature",
          id: "parkplatz.22151",
          geometry: { type: "Point", coordinates: [13.0436, 47.8153] },
          properties: {
            ID: 22151,
            BEZEICHNUNG: "Renaissance Hotel",
            TYP: "Garage/Parkhaus",
            FREIE_PLAETZE: "nicht bekannt",
            FREIE_PLAETZE_STATUS: 0,
            BELEGUNG_AKTUALISIERT: null,
          },
        },
      ],
    });
    const out = await parseSalzburgAtBundled(buf(fixture), ctx);
    expect(out.static.map((r) => r.poiId)).toEqual(["22101", "22151"]);
    expect(out.live.get("22101")?.freeSpaces).toBe(207);
    expect(out.live.has("22151")).toBe(false);
  });
});

describe("parseBielefeldDeBundled", () => {
  it("reads gid from properties (not feature.id), drops permit-only, and emits live state for PLS-enabled garages", async () => {
    const fixture = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          // Bielefeld's WFS does NOT set feature.id — only properties.gid.
          geometry: { type: "Point", coordinates: [8.537, 52.034] },
          properties: {
            gid: "620-1",
            typ: "P",
            bez: "Parkplatz",
            gebuehren: "Ausweis", // permit-only → must be skipped
            kategorie: "Unternehmen",
            zufahrt: "Schildescher Straße 25",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [8.598, 52.049] },
          properties: {
            gid: "620-10",
            typ: "P",
            bez: "Parkplatz",
            gebuehren: "kostenlos",
            kategorie: "Einzelhandel",
            kundenp: "J",
            zufahrt: "gegenüber Donauschwabenstraße 10",
          },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [8.532, 52.025] },
          properties: {
            gid: "660-6",
            pls_id: "PHT006",
            typ: "HZ",
            bez: "Parkhaus LOOM",
            kapazitaet: 529,
            hoehe: "2,10 m",
            einfahrtshoehe: 2.1,
            frauen: "J",
            behinderte: "J",
            e_ladesaeule: "J",
            zufahrt: "gegenüber Zimmerstraße 10",
            gebuehren_internet: "https://www.loom-bielefeld.de/parken/",
            oeff_mo_fr: "8:00 - 22:00",
            oeff_sa: "8:00 - 22:00",
            oeff_so: "geschlossen",
            b_pls_rest: 284,
            b_pls_zeit: "2026-05-27-17.45.00.000000",
            b_pls_status: "FREI",
          },
        },
      ],
    });
    const out = await parseBielefeldDeBundled(buf(fixture), ctx);
    const ids = out.static.map((r) => r.poiId).sort();
    expect(ids).toEqual(["620-10", "660-6"]);

    const loom = out.static.find((r) => r.poiId === "660-6");
    expect(loom?.payload.name).toBe("Parkhaus LOOM");
    expect(loom?.payload.parkingType).toBe("garage");
    expect(loom?.payload.capacity).toBe(529);
    expect(loom?.payload.maxHeight).toBe(210);
    expect(loom?.payload.disabledSpaces).toBe(1);
    expect(loom?.payload.womenSpaces).toBe(1);
    expect(loom?.payload.chargingSpaces).toBe(1);
    // OSM opening_hours notation — locale-neutral so the UI can localise it.
    expect(loom?.payload.openingHours).toBe("Mo-Fr 08:00-22:00; Sa 08:00-22:00; Su off");
    expect(loom?.payload.sourceUid).toBe("PHT006");
    expect(loom?.payload.hasPlsFeed).toBe(true);
    expect(loom?.payload.url).toBe("https://www.loom-bielefeld.de/parken/");

    expect(out.live.get("660-6")?.freeSpaces).toBe(284);
    expect(out.live.get("660-6")?.state).toBe("open");
    expect(out.live.get("660-6")?.asOf).toBe("2026-05-27T17:45:00.000Z");
    // Surface lot without PLS — no live entry.
    expect(out.live.has("620-10")).toBe(false);
  });

  it("collapses all-durchgehend days to '24/7' and preserves un-normalisable German qualifiers under English day labels", async () => {
    const make = (mo: string, sa: string, so: string) =>
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [8.532, 52.025] },
            properties: {
              gid: "660-X",
              pls_id: "PHTX",
              typ: "HZ",
              bez: "Test",
              kapazitaet: 100,
              oeff_mo_fr: mo,
              oeff_sa: sa,
              oeff_so: so,
            },
          },
        ],
      });

    const allOpen = await parseBielefeldDeBundled(
      buf(make("durchgehend", "durchgehend", "durchgehend")),
      ctx,
    );
    expect(allOpen.static[0].payload.openingHours).toBe("24/7");

    // Parenthetical German qualifier → can't normalise to OSM, but keep
    // operator-supplied info (entry deadline matters) behind English day
    // labels so an EN-UI user still sees the caveat.
    const withComment = await parseBielefeldDeBundled(
      buf(
        make(
          "8:00 - 22:00 (Einfahrt bis 21:30)",
          "8:00 - 22:00 (Einfahrt bis 21:30)",
          "geschlossen",
        ),
      ),
      ctx,
    );
    expect(withComment.static[0].payload.openingHours).toBe(
      "Mo-Fr 8:00 - 22:00 (Einfahrt bis 21:30); Sa 8:00 - 22:00 (Einfahrt bis 21:30); Su off",
    );

    // All three days identical and parseable → collapsed to a single "Mo-Su" rule
    // rather than repeating the value three times.
    const allSame = await parseBielefeldDeBundled(
      buf(make("7:00 - 21:00", "7:00 - 21:00", "7:00 - 21:00")),
      ctx,
    );
    expect(allSame.static[0].payload.openingHours).toBe("Mo-Su 07:00-21:00");
  });
});

describe("parseBambergDeBundled", () => {
  it("enriches known facility ids with static coordinates, drops unknown ids", async () => {
    const fixture = JSON.stringify({
      success: true,
      timestamp: "2026-05-27T13:52:56+00:00",
      cached: false,
      carParks: [
        { id: 14, name: "Tiefgarage Konzert", available: 247, total: 294, state: 4 },
        { id: 99999, name: "Unknown future facility", available: 5, total: 50, state: 4 },
      ],
    });
    const out = await parseBambergDeBundled(buf(fixture), ctx);
    expect(out.static.map((r) => r.poiId)).toEqual(["14"]);
    expect(out.live.get("14")?.freeSpaces).toBe(247);
    expect(out.live.get("14")?.state).toBe("open");
  });
});

describe("parseTrierDeBundled", () => {
  it("parses the SWT XML envelope, enriches each phname with static coords + OSM hours", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<parken>
  <datum>27.05.2026</datum>
  <uhrzeit>15:44:00</uhrzeit>
  <parkhaus><phname>Basi</phname><phstate>1</phstate><shortmax>176</shortmax><shortfree>62</shortfree><timeopen>00:00</timeopen><timeclose>24:00</timeclose></parkhaus>
  <parkhaus><phname>Hauptm</phname><phstate>1</phstate><shortmax>297</shortmax><shortfree>141</shortfree><timeopen>06:00</timeopen><timeclose>22:00</timeclose></parkhaus>
  <parkhaus><phname>UnknownNew</phname><phstate>1</phstate><shortmax>100</shortmax><shortfree>50</shortfree></parkhaus>
</parken>`;
    const out = await parseTrierDeBundled(buf(xml), ctx);
    expect(out.static.map((r) => r.poiId).sort()).toEqual(["Basi", "Hauptm"]);
    expect(out.live.get("Basi")?.freeSpaces).toBe(62);
    expect(out.live.get("Hauptm")?.state).toBe("open");
    // 00:00–24:00 (SWT's 24/7 convention) → OSM `24/7`, not "Mo–So: durchgehend".
    expect(out.static.find((r) => r.poiId === "Basi")?.payload.openingHours).toBe("24/7");
    // Bounded hours → OSM `Mo-Su HH:MM-HH:MM`, English day labels for locale-neutrality.
    expect(out.static.find((r) => r.poiId === "Hauptm")?.payload.openingHours).toBe(
      "Mo-Su 06:00-22:00",
    );
  });
});

describe("parsePotsdamDeBundled", () => {
  it("parses semicolon CSV, filters out-of-bbox entries, derives free=cap-occupied", async () => {
    const csv = [
      "Parkplatz;Belegung;Kapazitaet;Geo Point;Dynamische Daten",
      "P+R Bahnhof Pirschheide;128;184;52.3748911,13.0068318;True",
      "Wilhelmgalerie;45;52;48.8972345,9.1854717;True", // Stuttgart — must drop
      "Luisenplatz;68;213;52.3993911,13.0467921;True",
    ].join("\n");
    const out = await parsePotsdamDeBundled(buf(csv), ctx);
    const ids = out.static.map((r) => r.poiId).sort();
    expect(ids).toEqual(["Luisenplatz", "P+R Bahnhof Pirschheide"]);
    expect(out.live.get("P+R Bahnhof Pirschheide")?.freeSpaces).toBe(56);
    expect(out.live.get("Luisenplatz")?.freeSpaces).toBe(145);
    expect(out.static.find((r) => r.poiId === "P+R Bahnhof Pirschheide")?.payload.parkAndRide).toBe(
      true,
    );
  });
});

import { createHash } from "node:crypto";
import type { PoiRow, PoiSource } from "@openmapx/poi-source-registry";
import { parseApagBundled } from "./providers/apag-parser.js";
import { parseAutobahnDeBundled } from "./providers/autobahn-de-bundled-parser.js";
import { parseBarcelonaEsStatic } from "./providers/barcelona-es-parser.js";
import { parseBaselChBundled } from "./providers/basel-ch-parser.js";
import { parseBnlsFrStatic } from "./providers/bnls-fr-parser.js";
import { parseBrusselsBeStatic } from "./providers/brussels-be-parser.js";
import { parseCitaLuBundled } from "./providers/cita-lu-bundled-parser.js";
import { parseCopenhagenDkStatic } from "./providers/copenhagen-dk-parser.js";
import { parseDbBahnParkStatic } from "./providers/db-bahnpark-parser.js";
import { parseFlorenceItBundled } from "./providers/florence-it-parser.js";
import { parseGhentBeBundled } from "./providers/ghent-be-parser.js";
import { parseMadridEsStatic } from "./providers/madrid-es-parser.js";
import { makeMobidromBundledParser } from "./providers/mobidrom-bundled-parser.js";
import { parseNdwTruckNlBundled } from "./providers/ndw-truck-nl-bundled-parser.js";
import { parseNswAuBundled } from "./providers/nsw-au-bundled-parser.js";
import { parseOdhItBundled } from "./providers/opendatahub-it-bundled-parser.js";
import {
  parseOpenTransportDataChBundled,
  resolveOpenTransportDataChDownloadUrl,
} from "./providers/opentransportdata-ch-bundled-parser.js";
import { makeParkApiV2BundledParser } from "./providers/parkapi-v2-bundled-parser.js";
import { makeParkApiV3BundledParser } from "./providers/parkapi-v3-bundled-parser.js";
import { parseRdwNlStatic } from "./providers/rdw-nl-parser.js";
import { parseSingaporeLive } from "./providers/singapore-live-parser.js";
import { parseSingaporeStatic } from "./providers/singapore-static-parser.js";
import { parseUtmcLive } from "./providers/utmc-newcastle-live-parser.js";
import { parseUtmcStatic } from "./providers/utmc-newcastle-static-parser.js";
import { parseViennaAtStatic } from "./providers/vienna-at-parser.js";

// UTMC requires HTTP Basic on every request. The credential cascade lives in
// data-manager env vars (UTMC_USERNAME / UTMC_PASSWORD) rather than the
// integration's config-resolved cascade so the ingest scanner can synthesise
// the auth header at fetch time without round-tripping through apps/api.
// When unset we deliberately return {} and let the upstream 401 surface in
// the ingest status — operators see "missing creds" instead of a silent skip.
function utmcAuthHeader(): Record<string, string> {
  const u = process.env.UTMC_USERNAME;
  const p = process.env.UTMC_PASSWORD;
  if (!u || !p) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`,
    Accept: "application/json",
  };
}

// DB BahnPark uses two custom request headers (DB-Client-Id / DB-Api-Key) sourced
// from a Marketplace subscription. Same env-var-only contract as UTMC — when
// either var is unset we return {} and let the upstream 401 surface in the
// ingest status (instead of silently skipping).
function dbBahnParkHeaders(): Record<string, string> {
  const id = process.env.DB_BAHNPARK_CLIENT_ID;
  const key = process.env.DB_BAHNPARK_API_KEY;
  if (!id || !key) return {};
  return { "DB-Client-Id": id, "DB-Api-Key": key, Accept: "application/json" };
}

// NSW Transport API key — same pattern. The bundled parser also reads the
// same env var directly when fanning out per-facility detail calls, since
// the data-manager fetch stage only wraps the configured `url`.
function nswAuHeaders(): Record<string, string> {
  const key = process.env.NSW_TRANSPORT_API_KEY;
  if (!key) return {};
  return { Authorization: `apikey ${key}`, Accept: "application/json" };
}

const MOBIDROM_BASE = "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter";

// Hashing the sorted poiId set (rather than full payloads) is enough to skip
// the static table swap on no-op runs. The dominant drift mode for Mobidrom
// feeds is "one station added or removed"; payload-level churn (occupancy is
// already on the live side) doesn't need to trigger a swap.
function mobidromStaticChangeKey(rows: readonly PoiRow[]): string {
  const ids = rows.map((r) => r.poiId).sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

export function declarePoiSources(): PoiSource[] {
  return [
    {
      id: "utmc-newcastle",
      stationIdPrefix: "utmc:",
      domain: "parking",
      name: "UTMC Tyne & Wear — car parks",
      // [west, south, east, north]
      coverage: [-1.8, 54.85, -1.4, 55.1],
      static: {
        cron: "0 3 * * *",
        fetch: {
          type: "http",
          url: "https://www.netraveldata.co.uk/api/v2/carpark/static",
          timeoutMs: 15_000,
          resolveHeaders: async () => utmcAuthHeader(),
        },
        parse: parseUtmcStatic,
      },
      live: {
        cron: "*/2 * * * *",
        fetch: {
          type: "http",
          url: "https://www.netraveldata.co.uk/api/v2/carpark/dynamic",
          timeoutMs: 10_000,
          resolveHeaders: async () => utmcAuthHeader(),
        },
        parse: parseUtmcLive,
        // 5× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 600,
      },
    },
    {
      id: "brussels-be",
      stationIdPrefix: "brussels:",
      domain: "parking",
      name: "Brussels — public parking",
      coverage: [4.25, 50.78, 4.48, 50.92],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bruxelles_parkings_publics/records?limit=100",
          timeoutMs: 10_000,
        },
        parse: parseBrusselsBeStatic,
      },
    },
    {
      id: "madrid-es",
      stationIdPrefix: "madrid:",
      domain: "parking",
      name: "Madrid — public parking",
      coverage: [-3.9, 40.3, -3.5, 40.6],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://datos.madrid.es/egob/catalogo/202625-0-aparcamientos-publicos.json",
          timeoutMs: 30_000,
        },
        parse: parseMadridEsStatic,
      },
    },
    {
      id: "nrw-mobidrom-parking",
      stationIdPrefix: "nrw:",
      domain: "parking",
      name: "NRW Mobidrom — Parken NRW (aggregate)",
      coverage: [5.87, 50.32, 9.46, 52.53],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: `${MOBIDROM_BASE}/parken-nrw.json`,
          timeoutMs: 30_000,
        },
        parse: makeMobidromBundledParser({
          idPrefix: "nrw",
          sourceId: "nrw-mobidrom-parking",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "nrw-mobidrom-pr",
      stationIdPrefix: "nrw-pr:",
      domain: "parking",
      name: "NRW Mobidrom — Park+Ride NRW",
      coverage: [5.87, 50.32, 9.46, 52.53],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: `${MOBIDROM_BASE}/gebndelte-daten-parkride-nrw.json`,
          timeoutMs: 30_000,
        },
        parse: makeMobidromBundledParser({
          idPrefix: "nrw-pr",
          sourceId: "nrw-mobidrom-pr",
          forceParkAndRide: true,
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      // Primary APAG source: straight from apag.de's public PMS API. The
      // companion `apag-mobidrom` source ingests the same operator via the
      // NRW Mobilithek exporter as a backup data lineage; when Mobilithek is
      // down (its steady state) this primary source keeps live data flowing.
      // Same operator + same uuids upstream, so the static-row hash is stable
      // across both sources and dedup at the runtime layer falls back to
      // source-priority.
      id: "apag",
      stationIdPrefix: "apag:",
      domain: "parking",
      name: "APAG — Aachener Parkhaus GmbH",
      coverage: [5.9, 50.65, 6.3, 50.9],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://apag.de/api/v1/pms/facilities",
          timeoutMs: 30_000,
        },
        parse: parseApagBundled(),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "apag-mobidrom",
      stationIdPrefix: "apag-mobidrom:",
      domain: "parking",
      name: "APAG — Aachener Parkhaus GmbH",
      coverage: [5.9, 50.65, 6.3, 50.9],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: `${MOBIDROM_BASE}/parkplaetze-apag.json`,
          timeoutMs: 30_000,
        },
        parse: makeMobidromBundledParser({
          idPrefix: "apag-mobidrom",
          sourceId: "apag-mobidrom",
          operatorName: "APAG - Aachener Parkhaus GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "apcoa",
      stationIdPrefix: "apcoa:",
      domain: "parking",
      name: "APCOA Deutschland (via NRW Mobidrom)",
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: `${MOBIDROM_BASE}/parking-apcoa.json`,
          timeoutMs: 30_000,
        },
        parse: makeMobidromBundledParser({
          idPrefix: "apcoa",
          sourceId: "apcoa",
          operatorName: "APCOA Deutschland GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "parkapi-v3",
      stationIdPrefix: "parkapi-v3:",
      domain: "parking",
      name: "ParkAPI v3 (MobiData BW)",
      coverage: [5.5, 45.5, 15.5, 55.5],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites",
          timeoutMs: 30_000,
        },
        parse: makeParkApiV3BundledParser(),
        liveTtlSeconds: 1800,
        staticChangeKey: (rows) => mobidromStaticChangeKey(rows),
      },
    },
    {
      id: "parkapi-v2",
      stationIdPrefix: "parkapi-v2:",
      domain: "parking",
      name: "ParkAPI v2 (ParkenDD)",
      // Broad EU bbox — the federated parser prunes per-city to what
      // ParkenDD actually covers (DE/AT/CH and neighbours).
      coverage: [-5, 35, 30, 60],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://api.parkendd.de",
          // ~12 cities × ~7s/city upstream, concurrency-5 inside parse.
          // 90s is loose enough that one slow city doesn't fail the run.
          timeoutMs: 90_000,
        },
        parse: makeParkApiV2BundledParser(),
        liveTtlSeconds: 1800,
        staticChangeKey: (rows) => mobidromStaticChangeKey(rows),
      },
    },
    {
      id: "basel-ch",
      stationIdPrefix: "basel:",
      domain: "parking",
      name: "Basel-Stadt — public garages",
      coverage: [7.55, 47.52, 7.65, 47.6],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100014/records?limit=100",
          timeoutMs: 10_000,
        },
        parse: parseBaselChBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "copenhagen-dk",
      stationIdPrefix: "copenhagen:",
      domain: "parking",
      name: "Copenhagen — p_hus catalog",
      coverage: [12.45, 55.6, 12.68, 55.75],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=k101:p_hus&outputFormat=json&SRSNAME=EPSG:4326",
          timeoutMs: 30_000,
        },
        parse: parseCopenhagenDkStatic,
      },
    },
    {
      id: "florence-it",
      stationIdPrefix: "florence:",
      domain: "parking",
      name: "Florence — ParkFreeSpot",
      coverage: [11.18, 43.72, 11.32, 43.82],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://datastore.comune.fi.it/od/ParkFreeSpot.json",
          timeoutMs: 10_000,
        },
        parse: parseFlorenceItBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "ghent-be",
      stationIdPrefix: "ghent:",
      domain: "parking",
      name: "Stad Gent — real-time garages",
      coverage: [3.6, 50.95, 3.85, 51.15],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://data.stad.gent/api/explore/v2.1/catalog/datasets/bezetting-parkeergarages-real-time/records?limit=100",
          timeoutMs: 10_000,
        },
        parse: parseGhentBeBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "vienna-at",
      stationIdPrefix: "vienna:",
      domain: "parking",
      name: "Stadt Wien — GARAGENOGD",
      coverage: [16.18, 48.1, 16.58, 48.33],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:GARAGENOGD&srsName=EPSG:4326&outputFormat=json",
          timeoutMs: 30_000,
        },
        parse: parseViennaAtStatic,
      },
    },
    {
      id: "bnls-fr",
      stationIdPrefix: "bnls:",
      domain: "parking",
      name: "BNLS France — base nationale des lieux de stationnement",
      coverage: [-5.2, 41.3, 9.6, 51.1],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/mobilityref-france-base-nationale-des-lieux-de-stationnement/exports/geojson",
          timeoutMs: 60_000,
        },
        parse: parseBnlsFrStatic,
      },
    },
    {
      id: "barcelona-es",
      stationIdPrefix: "barcelona:",
      domain: "parking",
      name: "Barcelona — public parking",
      coverage: [2.05, 41.32, 2.23, 41.47],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://opendata-ajuntament.barcelona.cat/data/dataset/a8b29664-ab16-4341-9460-33f60d048d82/resource/3ed73d45-8ea6-4cdf-8984-11a4c4cfc9e8/download",
          timeoutMs: 30_000,
        },
        parse: parseBarcelonaEsStatic,
      },
    },
    {
      id: "cita-lu",
      stationIdPrefix: "cita-lu:",
      domain: "parking",
      name: "CITA Luxembourg — DATEX II parking",
      coverage: [5.7, 49.4, 6.6, 50.2],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://www.cita.lu/info_trafic/datex/parking_static.xml",
          timeoutMs: 15_000,
        },
        parse: parseCitaLuBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "ndw-truck-nl",
      stationIdPrefix: "ndw-truck:",
      domain: "parking",
      name: "NDW Netherlands — truck parking (DATEX II)",
      coverage: [3.3, 50.7, 7.3, 53.6],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://opendata.ndw.nu/Truckparking_Parking_Table.xml",
          timeoutMs: 30_000,
        },
        parse: parseNdwTruckNlBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "opendatahub-it",
      stationIdPrefix: "odh:",
      domain: "parking",
      name: "Open Data Hub South Tyrol — parking",
      coverage: [10.3, 46.2, 12.5, 47.1],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://mobility.api.opendatahub.com/v2/flat/ParkingStation?select=scode,sname,scoordinate,smetadata&where=sactive.eq.true&limit=200&shownull=false&distinct=true",
          timeoutMs: 15_000,
        },
        parse: parseOdhItBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "opentransportdata-ch-parking",
      stationIdPrefix: "otdch-parking:",
      domain: "parking",
      name: "OpenTransportData.swiss — bike & car parking",
      coverage: [5.96, 45.82, 10.49, 47.81],
      bundled: {
        // Dataset is a once-daily-ish publication; 10-minute cron mirrors the
        // pre-migration CACHE_TTL_MS so federated downstream stays fresh.
        cron: "*/10 * * * *",
        resolveUrl: resolveOpenTransportDataChDownloadUrl,
        fetch: {
          // Fallback URL — overridden every run by `resolveUrl`. The resolver
          // returns the same URL on scrape failure, so the fetch stage stays
          // functional even when the landing page is down.
          type: "http",
          url: "https://data.opentransportdata.swiss/dataset/379e6847-47c0-4dcc-8d8a-f7a6a8bd809a/resource/c7bb80f4-18b1-446a-83eb-aaf4fba87944/download/bike-and-car-parking.json",
          timeoutMs: 30_000,
        },
        parse: parseOpenTransportDataChBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "autobahn-de",
      stationIdPrefix: "autobahn:",
      domain: "parking",
      name: "Autobahn GmbH — rest area & truck parking",
      coverage: [5.8, 47.2, 15.1, 55.1],
      bundled: {
        // Federated per-road fan-out is heavy; 10-minute cron keeps the
        // upstream load reasonable for a feed that drifts on the order of days.
        cron: "*/10 * * * *",
        fetch: {
          type: "http",
          url: "https://verkehr.autobahn.de/o/autobahn",
          timeoutMs: 10_000,
        },
        parse: parseAutobahnDeBundled,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "db-bahnpark",
      stationIdPrefix: "db-bahnpark:",
      domain: "parking",
      name: "DB BahnPark — station parking (Germany)",
      // [west, south, east, north] — DACH-ish bbox; DB BahnPark covers DE
      // stations primarily.
      coverage: [5.5, 47.2, 15.1, 55.1],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://apis.deutschebahn.com/db-api-marketplace/apis/parking-information/db-bahnpark/v2/parking-facilities",
          timeoutMs: 30_000,
          resolveHeaders: async () => dbBahnParkHeaders(),
        },
        parse: parseDbBahnParkStatic,
      },
    },
    {
      id: "nsw-au",
      stationIdPrefix: "nsw:",
      domain: "parking",
      name: "Transport for NSW — car parks",
      coverage: [150.6, -34.8, 151.4, -33.4],
      bundled: {
        // The list endpoint feeds the parser; the parser then fans out per-
        // facility detail calls (~45 facilities). 5min cron mirrors the
        // OCCUPANCY_CACHE_TTL of the pre-migration provider.
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://api.transport.nsw.gov.au/v1/carpark",
          timeoutMs: 15_000,
          resolveHeaders: async () => nswAuHeaders(),
        },
        parse: parseNswAuBundled,
        liveTtlSeconds: 600,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      id: "singapore",
      stationIdPrefix: "sg:",
      domain: "parking",
      name: "Singapore — HDB carparks",
      coverage: [103.6, 1.2, 104.05, 1.48],
      static: {
        // ~2,300 records — limit=5000 covers the entire catalog in one fetch.
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://data.gov.sg/api/action/datastore_search?resource_id=d_23f946fa557947f93a8043bbef41dd09&limit=5000",
          timeoutMs: 30_000,
        },
        parse: parseSingaporeStatic,
      },
      live: {
        // data.gov.sg publishes per-minute snapshots; */5 keeps load reasonable.
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://api.data.gov.sg/v1/transport/carpark-availability",
          timeoutMs: 10_000,
        },
        parse: parseSingaporeLive,
        ttlSeconds: 1800,
      },
    },
    {
      id: "rdw-nl",
      stationIdPrefix: "rdw:",
      domain: "parking",
      name: "RDW Netherlands — parking & P+R",
      coverage: [3.3, 50.7, 7.3, 53.7],
      static: {
        // The configured fetch hits the largest dataset (specs); the parser
        // fans out three more reads (garages / P+R / carpool) and joins
        // in-memory. Once daily mirrors the pre-migration SPECS_CACHE_TTL.
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://opendata.rdw.nl/resource/b3us-f26s.json?$limit=5000",
          timeoutMs: 30_000,
        },
        parse: parseRdwNlStatic,
      },
    },
    {
      id: "goldbeck",
      stationIdPrefix: "goldbeck:",
      domain: "parking",
      name: "GOLDBECK Parking Services (via NRW Mobidrom)",
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: `${MOBIDROM_BASE}/parkplaetze-goldbeck-parking-services.json`,
          timeoutMs: 30_000,
        },
        parse: makeMobidromBundledParser({
          idPrefix: "goldbeck",
          sourceId: "goldbeck",
          operatorName: "GOLDBECK Parking Services GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
  ];
}

import { createHash } from "node:crypto";
import { integrationEnvVarName } from "@openmapx/integration-framework";
import type { PoiRow, PoiSource } from "@openmapx/poi-source-registry";
import { parseAt5SalzburgBundled } from "./providers/at-5-salzburg-parser.js";
import { parseAt9ViennaStatic } from "./providers/at-9-vienna-parser.js";
import { parseAuNswBundled } from "./providers/au-nsw-bundled-parser.js";
import { parseBeBruBrusselsStatic } from "./providers/be-bru-brussels-parser.js";
import { parseBeVlgGhentBundled } from "./providers/be-vlg-ghent-parser.js";
import { parseChBsBaselBundled } from "./providers/ch-bs-basel-parser.js";
import { parseChOtdBundled, resolveChOtdDownloadUrl } from "./providers/ch-otd-bundled-parser.js";
import { parseDeApagBundled } from "./providers/de-apag-parser.js";
import { parseDeAutobahnBundled } from "./providers/de-autobahn-bundled-parser.js";
import { parseDeBbPotsdamBundled } from "./providers/de-bb-potsdam-parser.js";
import { parseDeByBambergBundled } from "./providers/de-by-bamberg-parser.js";
import { parseDeDbBahnParkStatic } from "./providers/de-db-bahnpark-parser.js";
import { parseDeHbBremenStatic } from "./providers/de-hb-bremen-parser.js";
import { parseDeNiBraunschweigBundled } from "./providers/de-ni-braunschweig-parser.js";
import { parseDeNwBielefeldBundled } from "./providers/de-nw-bielefeld-parser.js";
import { parseDeNwDuesseldorfBundled } from "./providers/de-nw-duesseldorf-parser.js";
import { makeDeParkapiV2BundledParser } from "./providers/de-parkapi-v2-bundled-parser.js";
import { makeDeParkapiV3BundledParser } from "./providers/de-parkapi-v3-bundled-parser.js";
import { parseDeRpTrierBundled } from "./providers/de-rp-trier-parser.js";
import { parseDk84CopenhagenStatic } from "./providers/dk-84-copenhagen-parser.js";
import { parseEsCtBarcelonaStatic } from "./providers/es-ct-barcelona-parser.js";
import { parseEsMdMadridStatic } from "./providers/es-md-madrid-parser.js";
import { parseFrBnlsStatic } from "./providers/fr-bnls-parser.js";
import { parseGbEngUtmcLive } from "./providers/gb-eng-utmc-live-parser.js";
import { parseGbEngUtmcStatic } from "./providers/gb-eng-utmc-static-parser.js";
import { parseIt32OpendatahubBundled } from "./providers/it-32-opendatahub-bundled-parser.js";
import { parseIt52FlorenceBundled } from "./providers/it-52-florence-parser.js";
import { parseLuCitaBundled } from "./providers/lu-cita-bundled-parser.js";
import { makeMobidromBundledParser } from "./providers/mobidrom-bundled-parser.js";
import { parseNlNdwTruckBundled } from "./providers/nl-ndw-truck-bundled-parser.js";
import { parseNlRdwStatic } from "./providers/nl-rdw-parser.js";
import { parseSgHdbLive } from "./providers/sg-hdb-live-parser.js";
import { parseSgHdbStatic } from "./providers/sg-hdb-static-parser.js";

// UTMC requires HTTP Basic on every request. The credential is read straight
// from the data-manager environment — config keys `gb-eng-utmc-username` /
// `-password` derive the env vars INTEGRATION_PARKING_GB_ENG_UTMC_USERNAME /
// _PASSWORD — rather than through the integration's config-resolved cascade,
// so the ingest scanner can synthesise the auth header at fetch time without
// round-tripping through apps/api. Note this means the admin credential vault
// does NOT reach these: they must be set as environment variables.
// When unset we deliberately return {} and let the upstream 401 surface in
// the ingest status — operators see "missing creds" instead of a silent skip.
function utmcAuthHeader(): Record<string, string> {
  const u = process.env[integrationEnvVarName("parking", "gb-eng-utmc-username")];
  const p = process.env[integrationEnvVarName("parking", "gb-eng-utmc-password")];
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
  const id = process.env[integrationEnvVarName("parking", "de-db-bahnpark-client-id")];
  const key = process.env[integrationEnvVarName("parking", "de-db-bahnpark-api-key")];
  if (!id || !key) return {};
  return { "DB-Client-Id": id, "DB-Api-Key": key, Accept: "application/json" };
}

// NSW Transport API key — same pattern (config key `au-nsw-api-key` derives
// the env var INTEGRATION_PARKING_AU_NSW_API_KEY). The bundled parser reads
// that same env var directly when fanning out per-facility detail calls,
// since the data-manager fetch stage only wraps the configured `url`.
function nswAuHeaders(): Record<string, string> {
  const key = process.env[integrationEnvVarName("parking", "au-nsw-api-key")];
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
      parts: { country: "gb", subdivision: "eng", operator: "utmc" },
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
        parse: parseGbEngUtmcStatic,
      },
      live: {
        cron: "*/2 * * * *",
        fetch: {
          type: "http",
          url: "https://www.netraveldata.co.uk/api/v2/carpark/dynamic",
          timeoutMs: 10_000,
          resolveHeaders: async () => utmcAuthHeader(),
        },
        parse: parseGbEngUtmcLive,
        // 5× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 600,
      },
    },
    {
      parts: { country: "be", subdivision: "bru", operator: "brussels" },
      domain: "parking",
      name: "Brussels — public parking",
      coverage: [4.25, 50.78, 4.48, 50.92],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          // Single-snapshot dataset (~28 facilities). OpenDataSoft v2.1 caps
          // `limit` at 100 per page — fine here, ~3× headroom over the
          // current facility count.
          url: "https://opendata.brussels.be/api/explore/v2.1/catalog/datasets/bruxelles_parkings_publics/records?limit=100",
          timeoutMs: 10_000,
        },
        parse: parseBeBruBrusselsStatic,
      },
    },
    {
      parts: { country: "es", subdivision: "md", operator: "madrid" },
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
        parse: parseEsMdMadridStatic,
      },
    },
    {
      parts: { country: "de", subdivision: "nw", operator: "mobidrom" },
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
          sourceId: "de-nw-mobidrom",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "nw", operator: "mobidrom", stream: "pr" },
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
          sourceId: "de-nw-mobidrom-pr",
          forceParkAndRide: true,
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      // Primary APAG source: straight from apag.de's public PMS API. The
      // companion `de-apag-mobidrom` source ingests the same operator via the
      // NRW Mobilithek exporter as a backup data lineage; when Mobilithek is
      // down (its steady state) this primary source keeps live data flowing.
      // Same operator + same uuids upstream, so the static-row hash is stable
      // across both sources and dedup at the runtime layer falls back to
      // source-priority.
      parts: { country: "de", operator: "apag" },
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
        parse: parseDeApagBundled(),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", operator: "apag", stream: "mobidrom" },
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
          idPrefix: "de-apag-mobidrom",
          sourceId: "de-apag-mobidrom",
          operatorName: "APAG - Aachener Parkhaus GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", operator: "apcoa" },
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
          idPrefix: "de-apcoa",
          sourceId: "de-apcoa",
          operatorName: "APCOA Deutschland GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", operator: "parkapi", stream: "v3" },
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
        parse: makeDeParkapiV3BundledParser(),
        liveTtlSeconds: 1800,
        staticChangeKey: (rows) => mobidromStaticChangeKey(rows),
      },
    },
    {
      parts: { country: "de", operator: "parkapi", stream: "v2" },
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
        parse: makeDeParkapiV2BundledParser(),
        liveTtlSeconds: 1800,
        staticChangeKey: (rows) => mobidromStaticChangeKey(rows),
      },
    },
    {
      parts: { country: "ch", subdivision: "bs", operator: "basel" },
      domain: "parking",
      name: "Basel-Stadt — public garages",
      coverage: [7.55, 47.52, 7.65, 47.6],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          // Time-series dataset (~16 active facilities × hourly snapshots ≈
          // 1M records — `centralbahnparking` was decommissioned in 2024).
          // OpenDataSoft v2.1 caps `limit` at 100, so we order newest-first
          // and rely on the parser to dedupe by `id2`. 100 records covers
          // ~6 snapshots of all 16 active facilities — plenty of headroom
          // even if a snapshot is partial. A plain `limit=100` without
          // ordering would mix old and new snapshots and the parser would
          // pick whichever row appeared first (effectively random).
          url: "https://data.bs.ch/api/explore/v2.1/catalog/datasets/100014/records?limit=100&order_by=published%20desc",
          timeoutMs: 10_000,
        },
        parse: parseChBsBaselBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "dk", subdivision: "84", operator: "copenhagen" },
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
        parse: parseDk84CopenhagenStatic,
      },
    },
    {
      parts: { country: "it", subdivision: "52", operator: "florence" },
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
        parse: parseIt52FlorenceBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "be", subdivision: "vlg", operator: "ghent" },
      domain: "parking",
      name: "Stad Gent — real-time garages",
      coverage: [3.6, 50.95, 3.85, 51.15],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          // Single-snapshot dataset (~13 facilities, updated in place).
          // OpenDataSoft v2.1 caps `limit` at 100 — fine here, ~8× headroom.
          url: "https://data.stad.gent/api/explore/v2.1/catalog/datasets/bezetting-parkeergarages-real-time/records?limit=100",
          timeoutMs: 10_000,
        },
        parse: parseBeVlgGhentBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "at", subdivision: "9", operator: "vienna" },
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
        parse: parseAt9ViennaStatic,
      },
    },
    {
      parts: { country: "fr", operator: "bnls" },
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
        parse: parseFrBnlsStatic,
      },
    },
    {
      parts: { country: "es", subdivision: "ct", operator: "barcelona" },
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
        parse: parseEsCtBarcelonaStatic,
      },
    },
    {
      parts: { country: "lu", operator: "cita" },
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
        parse: parseLuCitaBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "nl", operator: "ndw", stream: "truck" },
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
        parse: parseNlNdwTruckBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "it", subdivision: "32", operator: "opendatahub" },
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
        parse: parseIt32OpendatahubBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "ch", operator: "otd" },
      domain: "parking",
      name: "OpenTransportData.swiss — bike & car parking",
      coverage: [5.96, 45.82, 10.49, 47.81],
      bundled: {
        // Dataset is a once-daily-ish publication; 10-minute cron mirrors the
        // pre-migration CACHE_TTL_MS so federated downstream stays fresh.
        cron: "*/10 * * * *",
        resolveUrl: resolveChOtdDownloadUrl,
        fetch: {
          // Fallback URL — overridden every run by `resolveUrl`. The resolver
          // returns the same URL on scrape failure, so the fetch stage stays
          // functional even when the landing page is down.
          type: "http",
          url: "https://data.opentransportdata.swiss/dataset/379e6847-47c0-4dcc-8d8a-f7a6a8bd809a/resource/c7bb80f4-18b1-446a-83eb-aaf4fba87944/download/bike-and-car-parking.json",
          timeoutMs: 30_000,
        },
        parse: parseChOtdBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", operator: "autobahn" },
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
        parse: parseDeAutobahnBundled,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", operator: "db", stream: "bahnpark" },
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
        parse: parseDeDbBahnParkStatic,
      },
    },
    {
      parts: { country: "au", operator: "nsw" },
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
        parse: parseAuNswBundled,
        liveTtlSeconds: 600,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "sg", operator: "hdb" },
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
        parse: parseSgHdbStatic,
      },
      live: {
        // data.gov.sg publishes per-minute snapshots; */5 keeps load reasonable.
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://api.data.gov.sg/v1/transport/carpark-availability",
          timeoutMs: 10_000,
        },
        parse: parseSgHdbLive,
        ttlSeconds: 1800,
      },
    },
    {
      parts: { country: "nl", operator: "rdw" },
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
        parse: parseNlRdwStatic,
      },
    },
    {
      parts: { country: "de", operator: "goldbeck" },
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
          idPrefix: "de-goldbeck",
          sourceId: "de-goldbeck",
          operatorName: "GOLDBECK Parking Services GmbH",
        }),
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "ni", operator: "braunschweig" },
      domain: "parking",
      name: "Stadt Braunschweig — PULP parking",
      coverage: [10.4, 52.18, 10.65, 52.36],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://www.braunschweig.de/apps/pulp/result/parkhaeuser.geojson",
          timeoutMs: 15_000,
        },
        parse: parseDeNiBraunschweigBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "hb", operator: "bremen" },
      domain: "parking",
      name: "VMZ Bremen — parking catalogue",
      coverage: [8.45, 53.0, 8.95, 53.25],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://vmz.bremen.de/geojson/parking.geojson",
          timeoutMs: 15_000,
        },
        parse: parseDeHbBremenStatic,
      },
    },
    {
      parts: { country: "de", subdivision: "nw", operator: "duesseldorf" },
      domain: "parking",
      name: "Stadt Düsseldorf — Parkhäuser (VT-Manager)",
      coverage: [6.65, 51.12, 6.95, 51.35],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://vtmanager.duesseldorf.de/geoserverwfs?request=getfeature&service=wfs&version=1.1.0&typename=Parkhaeuser&outputFormat=application/json&srsname=epsg:4326",
          timeoutMs: 15_000,
          headers: {
            // Geoserver rejects the default fetch UA with HTTP 403. Mirror what
            // the city's own viewer sends so the WFS treats us as a browser.
            "User-Agent": "Mozilla/5.0",
            Accept: "application/json",
          },
        },
        parse: parseDeNwDuesseldorfBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "at", subdivision: "5", operator: "salzburg" },
      domain: "parking",
      name: "Stadt Salzburg — parkplatz WFS",
      coverage: [12.95, 47.72, 13.13, 47.88],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://data.stadt-salzburg.at/geodaten/wfs?service=WFS&version=1.1.0&request=GetFeature&srsName=urn:x-ogc:def:crs:EPSG:4326&outputFormat=application/json&typeName=ogdsbg:parkplatz",
          timeoutMs: 15_000,
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        parse: parseAt5SalzburgBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "nw", operator: "bielefeld" },
      domain: "parking",
      name: "Stadt Bielefeld — parkplaetze WFS",
      coverage: [8.4, 51.9, 8.7, 52.13],
      bundled: {
        // The WFS bakes the PLS live counts (`b_pls_rest`, `b_pls_zeit`,
        // `b_pls_status`) into the same feature collection as the static
        // cadastre. Every 5 min matches the upstream PLS refresh cadence;
        // the static-row hash skips the swap when only live fields changed.
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          // The `; subtype=geojson` part is part of the OGC-defined media-type
          // identifier — URL-encoding the space avoids breakage at the HTTP
          // client edges that try to "fix" the header otherwise.
          url: "https://www.bielefeld01.de/md/WFS/parkplaetze/01?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=parkplaetze_p&SRSNAME=EPSG:4326&OUTPUTFORMAT=application%2Fjson%3B%20subtype%3Dgeojson",
          timeoutMs: 30_000,
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        parse: parseDeNwBielefeldBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "by", operator: "bamberg" },
      domain: "parking",
      name: "Stadtwerke Bamberg — Parken",
      coverage: [10.83, 49.85, 10.94, 49.94],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://www.stadtwerke-bamberg.de/carparkcounter/api/status",
          timeoutMs: 10_000,
        },
        parse: parseDeByBambergBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "rp", operator: "trier" },
      domain: "parking",
      name: "Stadtwerke Trier — parken-v2",
      coverage: [6.6, 49.72, 6.7, 49.78],
      bundled: {
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          // `www.swt.de` 301s to `service.swt.de`; we hit the redirect target
          // directly so the data-manager fetcher doesn't have to follow.
          url: "https://service.swt.de/parken-v2.xml",
          timeoutMs: 10_000,
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        parse: parseDeRpTrierBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
    {
      parts: { country: "de", subdivision: "bb", operator: "potsdam" },
      domain: "parking",
      name: "Stadtwerke Potsdam — parking CSV",
      coverage: [12.85, 52.32, 13.2, 52.5],
      bundled: {
        // SWP exposes a 5-min refresh cadence on the upstream telemetry; matching
        // it lets the bbox bbox filter + name-collision dedup converge on stable
        // rows before the next ingest.
        cron: "*/5 * * * *",
        fetch: {
          type: "http",
          url: "https://cs1-swp.westeurope.cloudapp.azure.com:8443/parking_csv",
          timeoutMs: 15_000,
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        parse: parseDeBbPotsdamBundled,
        liveTtlSeconds: 1800,
        staticChangeKey: mobidromStaticChangeKey,
      },
    },
  ];
}

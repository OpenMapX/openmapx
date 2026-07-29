import { gunzipSync } from "node:zlib";
import type { PoiSource, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { parseAuNsw, resolveNswUrl } from "./providers/au-nsw-parser.js";
import { AU_QLD_CSV_URL, parseAuQld } from "./providers/au-qld-parser.js";
import { parseAuVic } from "./providers/au-vic-parser.js";
import { BE_FLANDERS_URL, parseBeFlanders } from "./providers/be-flanders-parser.js";
import {
  CH_SFOE_OICP_DATA_URL,
  CH_SFOE_OICP_STATUS_URL,
  parseChSfoeOicpLive,
} from "./providers/ch-sfoe-live-parser.js";
import { parseChSfoeOicp } from "./providers/ch-sfoe-parser.js";
import { CY_CYNAP_URL, parseCyCynap } from "./providers/cy-cynap-parser.js";
import { parseDeBnetzaCsv, resolveDeBnetzaCsvUrl } from "./providers/de-bnetza-parser.js";
import { DE_OCPDB_LOCATIONS_URL, DE_OCPDB_SOURCES_URL } from "./providers/de-ocpdb-client.js";
import { parseDeOcpdbLive } from "./providers/de-ocpdb-live-parser.js";
import { parseDeOcpdb } from "./providers/de-ocpdb-parser.js";
import { ES_DGT_URL, parseEsDgt } from "./providers/es-dgt-parser.js";
import {
  FI_DIGITRAFFIC_LOCATIONS_URL,
  parseFiDigitraffic,
} from "./providers/fi-digitraffic-parser.js";
import { HK_EPD_URL, parseHkEpd } from "./providers/hk-epd-parser.js";
import { IE_ESB_CSV_URL, parseIeEsb } from "./providers/ie-esb-parser.js";
import { LT_VIALIETUVA_LOCATIONS_URL } from "./providers/lt-vialietuva-client.js";
import { parseLtVialietuva } from "./providers/lt-vialietuva-parser.js";
import { LU_CHARGY_URL, parseLuChargy } from "./providers/lu-chargy-parser.js";
import { parseNlDotnlLive } from "./providers/nl-dotnl-live-parser.js";
import { NL_DOTNL_LOCATIONS_URL, parseNlDotnl } from "./providers/nl-dotnl-parser.js";
import { NZ_EVROAM_URL, parseNzEvroam } from "./providers/nz-evroam-parser.js";

// The NDW/DOT-NL locations feed is served as a bare gzip body with no
// Content-Encoding header, so the generic poi-ingest http fetch stage (which
// only does response.arrayBuffer(), no transparent inflate) hands the raw
// gzip bytes straight through. parseNlDotnl/parseNlDotnlLive are written and
// tested against already-decompressed JSON buffers (mirroring how the CH
// parsers treat their buffer), so gunzip here at the wiring boundary before
// handing off to them.
const parseNlDotnlGzipped: PoiStaticParseFn = (buffer, ctx) =>
  parseNlDotnl(gunzipSync(buffer), ctx);
const parseNlDotnlLiveGzipped: typeof parseNlDotnlLive = (buffer, ctx) =>
  parseNlDotnlLive(gunzipSync(buffer), ctx);

export function declarePoiSources(): PoiSource[] {
  return [
    {
      parts: { country: "de", operator: "bnetza" },
      domain: "ev-charging",
      name: "Bundesnetzagentur — Ladesäulenregister",
      // [west, south, east, north]
      coverage: [5.5, 47.1, 15.6, 55.2],
      static: {
        cron: "0 4 * * *",
        resolveUrl: resolveDeBnetzaCsvUrl,
        fetch: { type: "http", timeoutMs: 30_000, encoding: "windows-1252" },
        parse: parseDeBnetzaCsv,
        // Sanity floor — registry today is ~65k; anything below this is a feed regression.
        minRowCount: 1000,
      },
    },
    {
      parts: { country: "de", operator: "ocpdb" },
      domain: "ev-charging",
      name: "OCPDB (MobiData BW) — German charging locations, live status & tariffs",
      // [west, south, east, north]
      coverage: [5.5, 47.1, 15.6, 55.2],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: DE_OCPDB_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseDeOcpdb,
        // Feed today is ~91k locations nationwide.
        minRowCount: 10_000,
      },
      live: {
        // Derives realtime sources from /sources (the seed), then pages only
        // those via source_uid — skips the static BNetzA bulk (~63% of
        // locations). Runs hourly; ttl = 2× the cron so one missed run stays
        // warm (kept in sync with the mapper's staleness guard).
        cron: "0 * * * *",
        fetch: { type: "http", url: DE_OCPDB_SOURCES_URL, timeoutMs: 30_000 },
        parse: parseDeOcpdbLive,
        ttlSeconds: 7200,
      },
    },
    {
      parts: { country: "ie", operator: "esb" },
      domain: "ev-charging",
      name: "ESB ecars — Irish & Northern Ireland public charging network",
      // [west, south, east, north]
      coverage: [-10.6, 51.3, -5.3, 55.5],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: IE_ESB_CSV_URL, timeoutMs: 30_000 },
        parse: parseIeEsb,
        // Register today is ~590 sites (RoI + NI).
        minRowCount: 100,
      },
    },
    {
      parts: { country: "cy", operator: "cynap" },
      domain: "ev-charging",
      name: "CYNAP — Cyprus public EV chargers",
      // [west, south, east, north]
      coverage: [32, 34.5, 34.65, 35.75],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: CY_CYNAP_URL, timeoutMs: 30_000 },
        parse: parseCyCynap,
        // ~171 charging points nationwide.
        minRowCount: 50,
      },
    },
    {
      parts: { country: "lu", operator: "chargy" },
      domain: "ev-charging",
      name: "Chargy — Luxembourg public charging network",
      // [west, south, east, north]
      coverage: [5.7, 49.4, 6.6, 50.2],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: LU_CHARGY_URL, timeoutMs: 30_000 },
        parse: parseLuChargy,
        // Full feed is ~527 placemarks.
        minRowCount: 100,
      },
    },
    {
      parts: { country: "nz", operator: "evroam" },
      domain: "ev-charging",
      name: "EVRoam — New Zealand charging network (Waka Kotahi)",
      // [west, south, east, north]
      coverage: [166, -47.5, 179, -34],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: NZ_EVROAM_URL, timeoutMs: 30_000 },
        parse: parseNzEvroam,
        // ArcGIS FeatureServer today reports ~638 stations.
        minRowCount: 200,
      },
    },
    {
      parts: { country: "es", operator: "dgt" },
      domain: "ev-charging",
      name: "DGT — Spanish national EV charging (NAP)",
      // [west, south, east, north]
      coverage: [-9.4, 35.9, 4.4, 43.8],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: ES_DGT_URL, timeoutMs: 60_000 },
        parse: parseEsDgt,
        // Feed today is ~12.3k sites nationwide.
        minRowCount: 2000,
      },
    },
    {
      parts: { country: "au", operator: "nsw", stream: "ev" },
      domain: "ev-charging",
      name: "Transport for NSW — EV charging locations",
      // [west, south, east, north]
      coverage: [140.9, -37.6, 153.7, -28],
      static: {
        cron: "0 5 * * *",
        // The CSV filename is date-stamped; resolveUrl re-resolves it each run.
        resolveUrl: resolveNswUrl,
        fetch: {
          type: "http",
          url: "https://opendata.transport.nsw.gov.au/data/dataset/be1c4de4-4517-4bd0-8a09-2965ddfc7179/resource/7bbb6461-e52d-4fe7-ace4-a15c30198de0/download/ev_20251216.csv",
          timeoutMs: 30_000,
        },
        parse: parseAuNsw,
        // Feed today is ~1,958 sites.
        minRowCount: 300,
      },
    },
    {
      parts: { country: "au", operator: "qld", stream: "ev" },
      domain: "ev-charging",
      name: "Department of Transport and Main Roads (Queensland) — EV charging locations",
      coverage: [138, -29, 154, -9],
      static: {
        cron: "0 5 * * *",
        fetch: { type: "http", url: AU_QLD_CSV_URL, timeoutMs: 30_000 },
        parse: parseAuQld,
        // Small hand-curated register — ~17 sites today.
        minRowCount: 5,
      },
    },
    {
      parts: { country: "au", operator: "vic", stream: "ev" },
      domain: "ev-charging",
      name: "State of Victoria (DEECA) — Destination Charger Program sites",
      coverage: [140.9, -39.2, 150, -33.9],
      static: {
        cron: "0 5 * * *",
        fetch: {
          type: "http",
          url: "https://opendata.maps.vic.gov.au/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=open-data-platform:dcav_site&outputFormat=application/json",
          timeoutMs: 30_000,
        },
        parse: parseAuVic,
        // Registry today is ~152 sites.
        minRowCount: 50,
      },
    },
    {
      parts: { country: "be", operator: "flanders" },
      domain: "ev-charging",
      name: "Vlaanderen — Flemish public EV charging",
      // [west, south, east, north]
      coverage: [2.5, 50.6, 5.95, 51.55],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: BE_FLANDERS_URL, timeoutMs: 60_000 },
        parse: parseBeFlanders,
        // ~86,944 per-connector rows grouped into stations today.
        minRowCount: 1000,
      },
    },
    {
      parts: { country: "hk", operator: "epd" },
      domain: "ev-charging",
      name: "EPD — Hong Kong public EV chargers",
      // [west, south, east, north]
      coverage: [113.8, 22.15, 114.5, 22.6],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: HK_EPD_URL, timeoutMs: 45_000 },
        parse: parseHkEpd,
        // Feed today is ~973 car-park records territory-wide.
        minRowCount: 200,
      },
    },
    {
      parts: { country: "fi", operator: "digitraffic" },
      domain: "ev-charging",
      name: "Fintraffic Digitraffic — Finnish national EV charging (AFIR)",
      // [west, south, east, north]
      coverage: [19, 59, 32, 70.5],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: FI_DIGITRAFFIC_LOCATIONS_URL, timeoutMs: 60_000 },
        parse: parseFiDigitraffic,
        // Feed today is ~3024 locations nationwide.
        minRowCount: 500,
      },
    },
    {
      parts: { country: "lt", operator: "vialietuva" },
      domain: "ev-charging",
      name: "Via Lietuva — Lithuanian national EV charging",
      // [west, south, east, north]
      coverage: [20.9, 53.8, 26.9, 56.5],
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: LT_VIALIETUVA_LOCATIONS_URL,
          timeoutMs: 60_000,
          // The Cloudflare-fronted host rejects requests with no User-Agent.
          headers: { "User-Agent": "OpenMapX/1.0" },
        },
        parse: parseLtVialietuva,
        // Feed today is ~2984 locations nationwide.
        minRowCount: 500,
      },
    },
    {
      parts: { country: "ch", operator: "sfoe" },
      domain: "ev-charging",
      name: "Charging points for electric cars (SFOE)",
      coverage: [5.9, 45.8, 10.6, 47.9],
      static: {
        cron: "0 5 * * *",
        fetch: {
          type: "http",
          url: CH_SFOE_OICP_DATA_URL,
          timeoutMs: 30_000,
        },
        parse: parseChSfoeOicp,
        // Registry today is ~9k stations.
        minRowCount: 500,
      },
      live: {
        cron: "*/5 * * * *",
        fetch: { type: "http", url: CH_SFOE_OICP_STATUS_URL, timeoutMs: 20_000 },
        parse: parseChSfoeOicpLive,
        // 6× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 1800,
      },
    },
    {
      parts: { country: "nl", operator: "dotnl" },
      domain: "ev-charging",
      name: "Publicly accessible charging points (DOT-NL / NDW)",
      coverage: [3.2, 50.7, 7.3, 53.6],
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: NL_DOTNL_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseNlDotnlGzipped,
        // Feed today is ~66.7k locations.
        minRowCount: 10_000,
      },
      live: {
        cron: "*/15 * * * *",
        fetch: { type: "http", url: NL_DOTNL_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseNlDotnlLiveGzipped,
        // 2× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 1800,
      },
    },
  ];
}

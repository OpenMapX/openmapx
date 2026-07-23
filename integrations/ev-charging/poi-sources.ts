import { gunzipSync } from "node:zlib";
import type { PoiSource, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import {
  CH_SFOE_OICP_DATA_URL,
  CH_SFOE_OICP_STATUS_URL,
  parseChSfoeOicpLive,
} from "./providers/ch-sfoe-live-parser.js";
import { parseChSfoeOicp } from "./providers/ch-sfoe-parser.js";
import { parseDeBnetzaCsv, resolveDeBnetzaCsvUrl } from "./providers/de-bnetza-parser.js";
import { DE_OCPDB_LOCATIONS_URL } from "./providers/de-ocpdb-client.js";
import { parseDeOcpdbLive } from "./providers/de-ocpdb-live-parser.js";
import { parseDeOcpdb } from "./providers/de-ocpdb-parser.js";
import { parseNlDotnlLive } from "./providers/nl-dotnl-live-parser.js";
import { NL_DOTNL_LOCATIONS_URL, parseNlDotnl } from "./providers/nl-dotnl-parser.js";

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
        // Re-pages all ~91 location pages, so a conservative interval keeps the
        // request volume sane; ttl = 2× the cron so one missed run stays warm.
        cron: "*/30 * * * *",
        fetch: { type: "http", url: DE_OCPDB_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseDeOcpdbLive,
        ttlSeconds: 3600,
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

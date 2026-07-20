import { gunzipSync } from "node:zlib";
import type { PoiSource, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { parseBnetzaCsv, resolveBnetzaCsvUrl } from "./providers/bnetza-parser.js";
import { parseDotNlLive } from "./providers/netherlands-live-parser.js";
import { DOTNL_LOCATIONS_URL, parseDotNl } from "./providers/netherlands-parser.js";
import {
  parseSwissOicpLive,
  SWISS_OICP_DATA_URL,
  SWISS_OICP_STATUS_URL,
} from "./providers/switzerland-live-parser.js";
import { parseSwissOicp } from "./providers/switzerland-parser.js";

// The NDW/DOT-NL locations feed is served as a bare gzip body with no
// Content-Encoding header, so the generic poi-ingest http fetch stage (which
// only does response.arrayBuffer(), no transparent inflate) hands the raw
// gzip bytes straight through. parseDotNl/parseDotNlLive are written and
// tested against already-decompressed JSON buffers (mirroring how the CH
// parsers treat their buffer), so gunzip here at the wiring boundary before
// handing off to them.
const parseDotNlGzipped: PoiStaticParseFn = (buffer, ctx) => parseDotNl(gunzipSync(buffer), ctx);
const parseDotNlLiveGzipped: typeof parseDotNlLive = (buffer, ctx) =>
  parseDotNlLive(gunzipSync(buffer), ctx);

export function declarePoiSources(): PoiSource[] {
  return [
    {
      id: "bnetza-ev",
      stationIdPrefix: "bnetza:",
      domain: "ev-charging",
      name: "Bundesnetzagentur — Ladesäulenregister",
      // [west, south, east, north]
      coverage: [5.5, 47.1, 15.6, 55.2],
      attributionSourceId: "bnetza-ev",
      static: {
        cron: "0 4 * * *",
        resolveUrl: resolveBnetzaCsvUrl,
        fetch: { type: "http", timeoutMs: 30_000, encoding: "windows-1252" },
        parse: parseBnetzaCsv,
        // Sanity floor — registry today is ~65k; anything below this is a feed regression.
        minRowCount: 1000,
      },
    },
    {
      id: "switzerland-ev",
      stationIdPrefix: "swiss-sfoe:",
      domain: "ev-charging",
      name: "Charging points for electric cars (SFOE)",
      coverage: [5.9, 45.8, 10.6, 47.9],
      attributionSourceId: "switzerland-ev",
      static: {
        cron: "0 5 * * *",
        fetch: {
          type: "http",
          url: SWISS_OICP_DATA_URL,
          timeoutMs: 30_000,
        },
        parse: parseSwissOicp,
        // Registry today is ~9k stations.
        minRowCount: 500,
      },
      live: {
        cron: "*/5 * * * *",
        fetch: { type: "http", url: SWISS_OICP_STATUS_URL, timeoutMs: 20_000 },
        parse: parseSwissOicpLive,
        // 6× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 1800,
      },
    },
    {
      id: "netherlands-ev",
      stationIdPrefix: "nl-dotnl:",
      domain: "ev-charging",
      name: "Publicly accessible charging points (DOT-NL / NDW)",
      coverage: [3.2, 50.7, 7.3, 53.6],
      attributionSourceId: "netherlands-ev",
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: DOTNL_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseDotNlGzipped,
        // Feed today is ~66.7k locations.
        minRowCount: 10_000,
      },
      live: {
        cron: "*/15 * * * *",
        fetch: { type: "http", url: DOTNL_LOCATIONS_URL, timeoutMs: 30_000 },
        parse: parseDotNlLiveGzipped,
        // 2× the cron interval — one missed run still leaves cached state alive.
        ttlSeconds: 1800,
      },
    },
  ];
}

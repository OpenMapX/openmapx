import type { PoiSource } from "@openmapx/poi-source-registry";
import { parseBnetzaCsv, resolveBnetzaCsvUrl } from "./providers/bnetza-parser.js";
import {
  parseSwissOicpLive,
  SWISS_OICP_DATA_URL,
  SWISS_OICP_STATUS_URL,
} from "./providers/switzerland-live-parser.js";
import { parseSwissOicp } from "./providers/switzerland-parser.js";

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
  ];
}

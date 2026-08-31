import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import {
  hostMatchesAllowlist,
  privateFeedHostAllowlist,
  safeFetchJson,
  safeFetchText,
} from "./utils/safe-download.js";
import { USER_AGENT } from "./utils/userAgent.js";

export const mobilityHttpTransport: MobilityHttpTransport = {
  userAgent: USER_AGENT,
  fetchJson: (url, options) => safeFetchJson(url, options),
  fetchText: (url, options) => safeFetchText(url, options),
  hostMatchesAllowlist,
  privateFeedHostAllowlist,
};

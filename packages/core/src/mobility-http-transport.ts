import type {
  MobilityHttpRequestOptions,
  MobilityHttpTransport,
} from "@openmapx/mobility-core/json-transport";
import {
  hostMatchesAllowlist,
  privateFeedHostAllowlist,
  safeFetchJson,
  safeFetchText,
} from "./utils/safe-download.js";
import { USER_AGENT } from "./utils/userAgent.js";

/**
 * Mobility requests are feed downloads, so they honour the operator's private
 * feed mirrors unless the caller names its own private hosts.
 */
function withFeedHosts(options: MobilityHttpRequestOptions | undefined) {
  return {
    ...options,
    allowPrivateHosts: options?.allowPrivateHosts ?? privateFeedHostAllowlist(),
  };
}

export const mobilityHttpTransport: MobilityHttpTransport = {
  userAgent: USER_AGENT,
  fetchJson: (url, options) => safeFetchJson(url, withFeedHosts(options)),
  fetchText: (url, options) => safeFetchText(url, withFeedHosts(options)),
  hostMatchesAllowlist,
  privateFeedHostAllowlist,
};

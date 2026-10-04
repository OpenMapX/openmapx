import { USER_AGENT_TRANSIT } from "@openmapx/core";
import { createMotisInstance, type MotisInstance } from "@openmapx/mobility-core/motis-client";

const DEFAULT_TRANSITOUS_URL = "https://api.transitous.org";
const REACHABILITY_TIMEOUT_MS = 30_000;

export interface TransitMotisInstances {
  motisLocalInstance: MotisInstance;
  motisLocalReachabilityInstance: MotisInstance;
  transitousInstance: MotisInstance;
}

export interface TransitousInstanceOptions {
  transitousUrl?: string;
  transitousUserAgent?: string;
}

export function createTransitousInstance(options: TransitousInstanceOptions): MotisInstance {
  return createMotisInstance({
    baseUrl: options.transitousUrl?.trim() || DEFAULT_TRANSITOUS_URL,
    prefix: "mo:",
    provider: "mo",
    userAgent: options.transitousUserAgent?.trim() || USER_AGENT_TRANSIT,
  });
}

export function createTransitMotisInstances(
  options: TransitousInstanceOptions & { localUrl: string },
): TransitMotisInstances {
  const local = {
    baseUrl: options.localUrl,
    prefix: "ms:",
    provider: "ms",
    userAgent: USER_AGENT_TRANSIT,
  };
  return {
    motisLocalInstance: createMotisInstance(local),
    motisLocalReachabilityInstance: createMotisInstance({
      ...local,
      timeoutMs: REACHABILITY_TIMEOUT_MS,
    }),
    transitousInstance: createTransitousInstance(options),
  };
}

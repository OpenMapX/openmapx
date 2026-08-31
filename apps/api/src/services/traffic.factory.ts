import { envString } from "@openmapx/core/server-env";
import { tomtomTrafficService } from "./tomtom-traffic.service";
import type { TrafficProvider } from "./traffic.provider";

export type TrafficProviderName = "tomtom";

const providers: Record<TrafficProviderName, TrafficProvider> = {
  tomtom: tomtomTrafficService,
};

function isTrafficProviderName(value: string): value is TrafficProviderName {
  return value in providers;
}

export function getTrafficProvider(): TrafficProvider {
  const raw = envString("TRAFFIC_PROVIDER", "tomtom").toLowerCase();
  if (!isTrafficProviderName(raw)) {
    throw new Error(`Unknown TRAFFIC_PROVIDER: "${raw}". Valid options: tomtom`);
  }

  return providers[raw];
}

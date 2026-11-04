import type {
  IntegrationContext,
  QuotaDecision,
  UpstreamCacheRead,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import { createOpenAQClient } from "./openaq-client.js";
import { createOpenAQProvider } from "./provider.js";

// A missing distributed runtime may never turn into an ungoverned upstream call.
const unavailableRuntime: UpstreamRuntime = {
  async read<T>(): Promise<UpstreamCacheRead<T>> {
    return { state: "miss", diagnostic: "store_unavailable" };
  },
  async write(): Promise<void> {
    throw new Error("Distributed upstream runtime is unavailable");
  },
  async acquireLease(): Promise<null> {
    return null;
  },
  async releaseLease(): Promise<void> {},
  async consumeQuota(): Promise<QuotaDecision> {
    return { allowed: false, remaining: {}, retryAt: null, diagnostic: "store_unavailable" };
  },
};

export function setup(ctx: IntegrationContext): void {
  const apiKey = ctx.config.openAqApiKey as string | undefined;
  const client = apiKey
    ? createOpenAQClient({
        http: ctx.http,
        upstreamRuntime: ctx.upstreamRuntime ?? unavailableRuntime,
        apiKey,
      })
    : null;
  const provider = client ? createOpenAQProvider(ctx, client) : null;
  if (provider) ctx.registerAirQualityProvider(provider);
}

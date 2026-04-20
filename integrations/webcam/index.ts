import { type IntegrationContext, setOverpassUrl } from "@openmapx/core";
import { registerPlaceResolver } from "@openmapx/core/server";
import { createDataSourceResolver } from "../data-source/resolver.js";
import { initCache } from "./cache.js";
import { setNpsApiKey } from "./providers/nps.js";
import { webcamProvider } from "./providers/provider.js";
import { setWindyApiKey } from "./providers/windy.js";

export function setup(ctx: IntegrationContext): void {
  initCache(ctx.cache);
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  setWindyApiKey(ctx.config.apiKey as string | undefined);
  setNpsApiKey(ctx.config.npsApiKey as string | undefined);
  ctx.registerProvider("data-source", webcamProvider);
  registerPlaceResolver(webcamProvider.id, createDataSourceResolver(webcamProvider));
}

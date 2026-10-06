import { mapConfigSchema } from "@openmapx/core/map-config";
import { serverApiUrl } from "@openmapx/core/server-api";
import { buildClientEnv, type ClientEnv } from "@/integration-api/runtime/env";

/** Resolve admin settings per page request, without forwarding user cookies or exposing keys. */
export async function loadClientEnv(): Promise<ClientEnv> {
  try {
    const response = await fetch(`${serverApiUrl()}/api/map-config`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) {
      const parsed = mapConfigSchema.safeParse(await response.json());
      if (parsed.success) return buildClientEnv(parsed.data);
    }
  } catch {
    // Availability is unknown: never silently send a self-hosted installation to a third party.
  }
  return buildClientEnv({
    hostedBasemapProvider: "auto",
    maptilerConfigured: false,
    selfHostedTilesUrl: "/tiles/data/openmapx.json",
    selfHostedGlyphsUrl: "/tiles",
  });
}

import type { IntegrationContext } from "@openmapx/integration-framework";
import { createTileProxyHandler } from "@openmapx/integration-framework/tile-proxy";

export function setup(ctx: IntegrationContext): void {
  const tileUrl =
    (ctx.config.tileUrl as string | undefined) ??
    "https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png";

  ctx.registerRoute(
    "GET",
    "/tiles/:z/:x/:y.png",
    createTileProxyHandler(ctx, {
      kind: "raster",
      label: "OpenSnowMap tile",
      url: ({ z, x, y }) =>
        tileUrl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)),
      maxZoom: 18,
      fallbackContentType: "image/png",
      cacheControl: "public, max-age=604800, s-maxage=604800",
    }),
    { rateLimitTier: "tile" },
  );
}

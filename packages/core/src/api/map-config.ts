import { z } from "zod";

export const hostedBasemapProviderSchema = z.enum(["auto", "openfreemap", "maptiler"]);
export type HostedBasemapProvider = z.infer<typeof hostedBasemapProviderSchema>;

/** Public bootstrap contract: credentials and internal service URLs never cross this boundary. */
export const mapConfigSchema = z
  .object({
    hostedBasemapProvider: hostedBasemapProviderSchema,
    maptilerConfigured: z.boolean(),
    selfHostedTilesUrl: z.enum(["", "/tiles/data/openmapx.json"]),
    selfHostedGlyphsUrl: z.enum(["", "/tiles"]),
  })
  .strict();
export type MapConfig = z.infer<typeof mapConfigSchema>;

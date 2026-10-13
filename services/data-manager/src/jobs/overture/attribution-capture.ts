import { readFileSync } from "node:fs";
import { dataSourceToAttribution } from "@openmapx/core";

/** Producer metadata is captured before acquisition and retained with its bytes.
 * This catalogue is not itself a list of credited display contributors. */
export function captureOvertureCatalogue(retrievedAt: string) {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../../../../integrations/poi-overture/manifest.json", import.meta.url),
      "utf8",
    ),
  ) as { dataSources: Parameters<typeof dataSourceToAttribution>[0][] };
  return manifest.dataSources.map((source) => ({
    ...dataSourceToAttribution(source),
    retrievedAt,
  }));
}

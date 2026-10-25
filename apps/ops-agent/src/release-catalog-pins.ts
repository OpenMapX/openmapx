import { readFileSync } from "node:fs";
import {
  decodeGbfsCatalogLock,
  decodeTransitousLock,
  type GbfsCatalogLock,
  type TransitousLock,
} from "@openmapx/transitous-core";

/**
 * The catalog pins this release ships, read through literal
 * `new URL(…, import.meta.url)` references: the agent's runtime bundle carries
 * copies its digest covers and reads those, never the host checkout's. Run
 * from source (tests), they name the repository's own files.
 */

/** The release's Transitous catalog pin. */
export function releaseTransitousPin(): TransitousLock {
  return decodeTransitousLock(
    JSON.parse(
      readFileSync(new URL("../../../infra/docker/transitous.lock.json", import.meta.url), "utf8"),
    ),
    "The release's Transitous catalog pin",
  );
}

/** The release's GBFS registry pin. */
export function releaseGbfsCatalogPin(): GbfsCatalogLock {
  return decodeGbfsCatalogLock(
    JSON.parse(
      readFileSync(
        new URL("../../../infra/docker/gbfs-catalog.lock.json", import.meta.url),
        "utf8",
      ),
    ),
    "The release's GBFS catalog pin",
  );
}

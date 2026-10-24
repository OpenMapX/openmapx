import { fileURLToPath } from "node:url";
import type { BuiltInServiceManifestSource } from "./built-in-service-source";

/**
 * The ops-agent runtime bundle's variant of `embedded-built-in-services.ts`.
 *
 * The bundler copies every literal URL below into the bundle's `assets/`, so
 * the bundle digest, which the release build checks, covers each manifest. The
 * agent and the fixed CLI it runs ship in the same bundle directory and read
 * the same copies. Run from source, the URLs name the repository's own
 * manifests.
 */
export function embeddedBuiltInServiceManifests(): BuiltInServiceManifestSource | null {
  const urls: Record<string, URL> = {
    "app-api": new URL("../../../../services/app-api/service.json", import.meta.url),
    "app-web": new URL("../../../../services/app-web/service.json", import.meta.url),
    brouter: new URL("../../../../services/brouter/service.json", import.meta.url),
    "data-manager": new URL("../../../../services/data-manager/service.json", import.meta.url),
    "dawarich-app": new URL("../../../../services/dawarich-app/service.json", import.meta.url),
    "dawarich-postgis": new URL(
      "../../../../services/dawarich-postgis/service.json",
      import.meta.url,
    ),
    "dawarich-redis": new URL("../../../../services/dawarich-redis/service.json", import.meta.url),
    "dawarich-sidekiq": new URL(
      "../../../../services/dawarich-sidekiq/service.json",
      import.meta.url,
    ),
    elasticsearch: new URL("../../../../services/elasticsearch/service.json", import.meta.url),
    "local-ai": new URL("../../../../services/local-ai/service.json", import.meta.url),
    martin: new URL("../../../../services/martin/service.json", import.meta.url),
    motis: new URL("../../../../services/motis/service.json", import.meta.url),
    "motis-feed-proxy": new URL(
      "../../../../services/motis-feed-proxy/service.json",
      import.meta.url,
    ),
    "motis-staging": new URL("../../../../services/motis-staging/service.json", import.meta.url),
    nominatim: new URL("../../../../services/nominatim/service.json", import.meta.url),
    "ops-agent": new URL("../../../../services/ops-agent/service.json", import.meta.url),
    osrm: new URL("../../../../services/osrm/service.json", import.meta.url),
    otp: new URL("../../../../services/otp/service.json", import.meta.url),
    overpass: new URL("../../../../services/overpass/service.json", import.meta.url),
    pelias: new URL("../../../../services/pelias/service.json", import.meta.url),
    "pelias-pip": new URL("../../../../services/pelias-pip/service.json", import.meta.url),
    "pelias-placeholder": new URL(
      "../../../../services/pelias-placeholder/service.json",
      import.meta.url,
    ),
    photon: new URL("../../../../services/photon/service.json", import.meta.url),
    postgis: new URL("../../../../services/postgis/service.json", import.meta.url),
    redis: new URL("../../../../services/redis/service.json", import.meta.url),
    tileserver: new URL("../../../../services/tileserver/service.json", import.meta.url),
    traefik: new URL("../../../../services/traefik/service.json", import.meta.url),
    "transitous-runner": new URL(
      "../../../../services/transitous-runner/service.json",
      import.meta.url,
    ),
    valhalla: new URL("../../../../services/valhalla/service.json", import.meta.url),
    "well-known": new URL("../../../../services/well-known/service.json", import.meta.url),
  };
  return {
    ids: Object.keys(urls).sort(),
    manifestPath(id) {
      if (!Object.hasOwn(urls, id)) throw new Error(`Unknown built-in service ${id}`);
      return fileURLToPath(urls[id] as URL);
    },
    embedded: true,
  };
}

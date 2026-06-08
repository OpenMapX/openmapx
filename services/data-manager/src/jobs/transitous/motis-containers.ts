/**
 * MOTIS container names the data-manager addresses by bare name over the docker
 * CLI (`docker exec`, `docker restart`, `docker stop`). These MUST match the
 * `container.containerName` pinned in the corresponding service manifests
 * (services/motis/, services/motis-staging/, services/motis-feed-proxy/): the
 * compose renderer emits `container_name` from those manifests, and any
 * mismatch surfaces only at runtime as "No such container". A guard test
 * (manifest-container-names.test.ts) asserts the two stay in sync, so this is
 * the single source of truth on the data-manager side.
 */
export const PRIMARY_CONTAINER = "motis";
export const STAGING_CONTAINER = "motis-staging";
export const FEED_PROXY_CONTAINER = "motis-feed-proxy";

import { services } from "@openmapx/core/server";

/**
 * The MOTIS containers the transit pipeline names in its results and stop
 * requests. Data-manager runs no Docker command itself: the operations agent
 * acts on these containers through typed operations, and both derive the
 * names from the service ids with `serviceContainerName`.
 */
export const PRIMARY_CONTAINER = services.serviceContainerName("motis");
export const STAGING_CONTAINER = services.serviceContainerName("motis-staging");

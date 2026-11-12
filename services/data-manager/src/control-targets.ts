import { services } from "@openmapx/core/server";

/** Configuration fences borrow the complete built-in application closure,
 * including services the Data Manager itself never starts or replaces.
 * Installed community-extension services are added per fence from the
 * agent-signed target lease, since only the agent knows which are installed. */
export const DATA_MANAGER_CONTROL_SERVICE_IDS = services.RELEASE_BUILT_IN_SERVICE_IDS;

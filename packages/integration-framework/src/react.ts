/**
 * Client-only entry. Importing `@openmapx/integration-framework/react` pulls
 * the React-dependent registry hook + context. The main `@openmapx/integration-framework`
 * barrel intentionally stays React-free so API and CLI builds that don't ship
 * `react` can load it (e.g. the CLI backup path that only needs validateManifest).
 */
import { useSyncExternalStore } from "react";
import { getCommunityModulesVersion, subscribeCommunityModules } from "./community";

export { type HostMapApi, HostMapContext, useHostMap } from "./hostMap";
export {
  NavIncidentContext,
  type NavIncidentResource,
  type NavIncidentStatus,
  useNavIncidentResource,
} from "./navIncidents";
export { IntegrationRegistryContext, useIntegrationRegistry } from "./useIntegrationRegistry";

/**
 * Re-render when a community bundle self-registers a frontend module. The
 * frontend hosts call this so a community map layer / legend / panel that loads
 * after first paint actually mounts (the registration happens outside React's
 * render cycle, via the bundle's `window.__openmapx_integrations.push`).
 */
export function useCommunityModulesVersion(): number {
  return useSyncExternalStore(
    subscribeCommunityModules,
    getCommunityModulesVersion,
    getCommunityModulesVersion,
  );
}

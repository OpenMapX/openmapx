/**
 * Client-only entry. Importing `@openmapx/integration-framework/react` pulls
 * the React-dependent registry hook + context. The main `@openmapx/integration-framework`
 * barrel intentionally stays React-free so API and CLI builds that don't ship
 * `react` can load it (e.g. the CLI backup path that only needs validateManifest).
 */
export {
  NavIncidentContext,
  type NavIncidentResource,
  type NavIncidentStatus,
  useNavIncidentResource,
} from "./navIncidents";
export { IntegrationRegistryContext, useIntegrationRegistry } from "./useIntegrationRegistry";

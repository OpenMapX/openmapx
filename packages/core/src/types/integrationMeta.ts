/** Runtime DTOs are owned by the API contract; manifests remain portable. */
export type {
  IntegrationDataSource,
  IntegrationFrontend as IntegrationFrontendMeta,
} from "@openmapx/extension-contracts/integration";
export type {
  IntegrationMetadata as LoadedIntegrationMeta,
  LocaleStrings as IntegrationStrings,
  PublicIntegrationHealthCheck as IntegrationHealthCheck,
} from "../api/contracts/runtime-metadata";

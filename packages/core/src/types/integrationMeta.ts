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

export interface CacheClient {
  /**
   * Host administration events; immediately reports current availability.
   * Clear local copies on every event and bypass them while unavailable.
   * Absent in clients without host administration (for example CLI fixtures).
   */
  onInvalidate?(listener: (event: { available: boolean }) => void): () => void;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Loader signal belongs to the shared cache fill, not any one request. */
  withCache<T>(
    key: string,
    ttlSeconds: number,
    fn: (operationSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
    shouldCache?: (value: T) => boolean,
  ): Promise<T>;
}

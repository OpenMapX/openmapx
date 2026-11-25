/**
 * Canonical env-var name for an integration's lowerCamel config key: the id
 * and the key's words in upper snake case, so `rateLimitPerIpPerHour` of
 * `search-nlp` maps to `INTEGRATION_SEARCH_NLP_RATE_LIMIT_PER_IP_PER_HOUR`.
 */
export { integrationConfigEnvName as integrationEnvVarName } from "@openmapx/core/services/config-env-names";

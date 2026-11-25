/**
 * The host environment variables that set integration and service
 * configuration. Every place that names one derives it here.
 *
 * This module imports nothing, so the integration framework can use it.
 */

function idSegment(id: string): string {
  return id.replaceAll("-", "_").toUpperCase();
}

/**
 * Splits a lowerCamel key into words: `rateLimitPerIpPerHour` →
 * `RATE_LIMIT_PER_IP_PER_HOUR`. Setting, integration and service variable
 * names all split words this way.
 */
export function camelToUpperSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * The variable for an integration's lowerCamel config key, for example
 * `INTEGRATION_SEARCH_NLP_RATE_LIMIT_PER_IP_PER_HOUR` for `search-nlp` and
 * `rateLimitPerIpPerHour`.
 */
export function integrationConfigEnvName(integrationId: string, key: string): string {
  return `INTEGRATION_${idSegment(integrationId)}_${camelToUpperSnake(key)}`;
}

/** The prefix of every variable of a service's configuration, `SERVICE_<ID>_`. */
export function serviceConfigEnvPrefix(serviceId: string): string {
  return `SERVICE_${idSegment(serviceId)}_`;
}

/**
 * The variable for a service's UPPER_SNAKE config key, used as is: for
 * example `SERVICE_VALHALLA_BUILD_ELEVATION`.
 */
export function serviceConfigEnvName(serviceId: string, key: string): string {
  return `${serviceConfigEnvPrefix(serviceId)}${key}`;
}

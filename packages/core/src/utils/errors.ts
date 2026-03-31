/**
 * Thrown when a required configuration value (API key, env var) is missing.
 * Data source routes catch this and return 503.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

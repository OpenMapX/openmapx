export type SettingSource = "default" | "database" | "env";

export interface SettingResolution<T> {
  value: T;
  source: SettingSource;
  invalidEnv: boolean;
}

/** Resolve one setting without trusting malformed values at either source. */
export function resolveSettingPrecedence<T>(options: {
  envValue?: string;
  databaseValue: unknown;
  defaultValue: T;
  parseEnv: (raw: string) => unknown;
  validate: (value: unknown) => value is T;
}): SettingResolution<T> {
  const envConfigured = options.envValue !== undefined && options.envValue !== "";
  if (envConfigured) {
    try {
      const value = options.parseEnv(options.envValue ?? "");
      if (options.validate(value)) return { value, source: "env", invalidEnv: false };
    } catch {
      // Fall through to a validated database value or the declared default.
    }
  }
  if (options.validate(options.databaseValue)) {
    return { value: options.databaseValue, source: "database", invalidEnv: envConfigured };
  }
  return { value: options.defaultValue, source: "default", invalidEnv: envConfigured };
}

import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { systemSecret, systemSetting } from "../db/schema";
import { actorUserIdOrNull } from "../utils/actor";
import { assertSecretsConfigured, decrypt, encrypt, secretAad } from "./secrets";
import { SETTING_DEFS, type SettingDef, settingEnvName } from "./setting-defs";

export {
  PLATFORM_CONFIGURATION_SETTING,
  SETTING_DEFS,
  type SettingDef,
  type SmtpSecurity,
  settingEnvName,
} from "./setting-defs";

export type SettingSource = "default" | "database" | "env";

interface ResolvedSetting {
  group: string;
  subgroup?: string;
  key: string;
  label: string;
  description?: string;
  type: string;
  options?: string[];
  secret: boolean;
  value: unknown;
  source: SettingSource;
  envVar?: string;
  envOverride: boolean;
  showWhen?: { key: string; equals: unknown | unknown[] };
  /** A stored secret in effect that the current secrets key cannot decrypt,
   * or a stored value in effect that the setting does not accept. */
  unreadable?: true;
}

interface SettingsGroup {
  id: string;
  label: string;
  settings: ResolvedSetting[];
}

const GROUP_LABELS: Record<string, string> = {
  auth: "Authentication",
  email: "Email",
  map: "Map",
  policy: "Data-Use Policy",
  legal: "Legal",
  extensions: "Extensions",
};

const DEFS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(
  SETTING_DEFS.map((def) => [def.key, def]),
);

/** A setting's value, from the environment or the database, is not one it accepts. */
export class SettingValueError extends Error {
  override name = "SettingValueError";
}

/** The definition of a known setting; throws for an unknown key. */
export function settingDefinition(key: string): SettingDef {
  const def = DEFS_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return def;
}

/** The environment variable of a setting, or undefined when only the database sets it. */
export function settingEnvVar(def: SettingDef): string | undefined {
  return def.env || def.envOnly ? settingEnvName(def.key) : undefined;
}

/** Whether the given environment sets a setting (an empty value does not). */
export function isSetInEnvironment(
  def: SettingDef,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const name = settingEnvVar(def);
  return name !== undefined && Boolean(env[name]?.trim());
}

/**
 * Parse an environment value for a setting. Booleans accept exactly
 * `true|false|1|0`, numbers plain decimal digits, objects strict JSON.
 * Throws for anything else; the caller checks the result's range.
 */
export function parseEnvValue(raw: string, def: SettingDef): unknown {
  if (def.parse) return def.parse(raw);
  switch (def.type) {
    case "boolean":
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new Error("not one of true, false, 1, 0");
    case "number":
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error("not a decimal number");
      return Number(raw);
    case "object":
      return JSON.parse(raw);
    default:
      return raw;
  }
}

export function matchesDeclaredType(def: SettingDef, value: unknown): boolean {
  if (def.validate && !def.validate(value)) return false;
  switch (def.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "select":
      return typeof value === "string" && (def.options?.includes(value) ?? true);
    case "object":
      return typeof value === "object" && value !== null;
  }
}

/**
 * The environment's value of a setting: `undefined` when the variable is not
 * set or empty, otherwise the parsed value. Throws SettingValueError, naming
 * the variable, for a value the setting does not accept.
 */
export function settingFromEnvironment(
  def: SettingDef,
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  const name = settingEnvVar(def);
  if (!name) return undefined;
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = parseEnvValue(raw, def);
  } catch (error) {
    throw new SettingValueError(`${name} is invalid: ${(error as Error).message}`);
  }
  if (!matchesDeclaredType(def, value))
    throw new SettingValueError(`${name} is invalid for the setting ${def.key}`);
  return value;
}

/**
 * Refuses every invalid environment value of a setting at once, naming the
 * variables. The API calls it before it starts serving.
 */
export function assertSettingsEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const problems: string[] = [];
  for (const def of SETTING_DEFS) {
    try {
      settingFromEnvironment(def, env);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length > 0) throw new SettingValueError(problems.join("; "));
}

/** Whether a setting's value is kept encrypted in `system_secret`. */
export function isSecretSetting(key: string): boolean {
  return DEFS_BY_KEY.get(key)?.secret === true;
}

/** A stored secret setting cannot be decrypted: the secrets key is missing,
 * unusable or not the key the value was saved with. */
export class SecretSettingUnreadableError extends Error {
  constructor(
    readonly setting: string,
    cause: unknown,
  ) {
    super(`The secret setting ${setting} cannot be read: ${(cause as Error).message}`, { cause });
    this.name = "SecretSettingUnreadableError";
  }
}

/** The secret settings that have a stored value. Nothing is decrypted. */
export async function storedSecretSettingKeys(database: typeof db = db): Promise<Set<string>> {
  const rows = await database.select({ key: systemSecret.key }).from(systemSecret);
  return new Set(rows.map((row) => row.key).filter(isSecretSetting));
}

/**
 * The values of the given settings, each resolved in the same order: a set
 * environment variable, then the stored value, then the declared default.
 * Secret values are decrypted only for settings the environment does not
 * set. With `database: null` stored values are not read.
 *
 * Throws SettingValueError for a value a setting does not accept and
 * SecretSettingUnreadableError for a stored secret that cannot be decrypted.
 */
export async function resolveSettingValues(
  keys: readonly string[],
  options: { database?: typeof db | null } = {},
): Promise<Record<string, unknown>> {
  const database = options.database === undefined ? db : options.database;
  const defs = keys.map(settingDefinition);
  const values: Record<string, unknown> = {};
  const fromDatabase: SettingDef[] = [];
  for (const def of defs) {
    const env = settingFromEnvironment(def);
    if (env !== undefined) values[def.key] = env;
    else if (def.envOnly || !database) values[def.key] = def.default;
    else fromDatabase.push(def);
  }
  if (fromDatabase.length === 0 || !database) return values;
  const plainKeys = fromDatabase.filter((def) => !def.secret).map((def) => def.key);
  const secretKeys = fromDatabase.filter((def) => def.secret).map((def) => def.key);
  const stored = new Map<string, unknown>();
  if (plainKeys.length > 0) {
    const rows = await database
      .select({ key: systemSetting.key, value: systemSetting.value })
      .from(systemSetting)
      .where(inArray(systemSetting.key, plainKeys));
    for (const row of rows) stored.set(row.key, row.value);
  }
  if (secretKeys.length > 0) {
    const rows = await database
      .select()
      .from(systemSecret)
      .where(inArray(systemSecret.key, secretKeys));
    for (const row of rows) {
      try {
        stored.set(row.key, decrypt(row, secretAad.systemSecret(row.key)));
      } catch (error) {
        throw new SecretSettingUnreadableError(row.key, error);
      }
    }
  }
  for (const def of fromDatabase) {
    if (!stored.has(def.key)) {
      values[def.key] = def.default;
      continue;
    }
    const value = stored.get(def.key);
    if (!matchesDeclaredType(def, value))
      throw new SettingValueError(`The stored value of the setting ${def.key} is invalid`);
    values[def.key] = value;
  }
  return values;
}

/** The value of one setting; see `resolveSettingValues`. */
export async function resolveSetting(
  key: string,
  options: { database?: typeof db | null } = {},
): Promise<unknown> {
  return (await resolveSettingValues([key], options))[key];
}

/**
 * The stored settings in effect (the environment does not set them) whose
 * value the setting does not accept, for example a row edited by hand or a
 * value saved before a later release narrowed the setting. Their readers
 * refuse them; the API still starts, so an administrator can save a valid
 * value. Secrets are not decrypted here.
 */
export async function invalidStoredSettings(database: typeof db = db): Promise<Set<string>> {
  const keys = SETTING_DEFS.filter(
    (def) => !def.secret && !def.envOnly && settingFromEnvironment(def) === undefined,
  ).map((def) => def.key);
  const invalid = new Set<string>();
  if (keys.length === 0) return invalid;
  const rows = await database
    .select({ key: systemSetting.key, value: systemSetting.value })
    .from(systemSetting)
    .where(inArray(systemSetting.key, keys));
  for (const row of rows) {
    if (!matchesDeclaredType(settingDefinition(row.key), row.value)) invalid.add(row.key);
  }
  return invalid;
}

/** Store the given settings in one transaction, attributed to the acting
 * administrator, or to nobody when no account acts. Secret
 * settings are encrypted into `system_secret`; an empty value removes one. */
export async function saveSystemSettings(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  actorId: string | null,
  database: typeof db = db,
): Promise<void> {
  const updatedByUserId = actorUserIdOrNull(actorId);
  for (const { key, value } of entries) {
    const def = settingDefinition(key);
    if (def.envOnly) throw new Error(`The setting ${key} is set only by the environment`);
    if (!matchesDeclaredType(def, value)) throw new SettingValueError(`Invalid value for ${key}`);
  }
  const secrets = entries.filter(({ key }) => isSecretSetting(key));
  if (secrets.some(({ value }) => value !== "")) assertSecretsConfigured();
  await database.transaction(async (transaction) => {
    for (const { key, value } of entries) {
      if (isSecretSetting(key)) {
        if (value === "") {
          await transaction.delete(systemSecret).where(eq(systemSecret.key, key));
          continue;
        }
        const sealed = encrypt(value as string, secretAad.systemSecret(key));
        await transaction
          .insert(systemSecret)
          .values({ key, ...sealed, updatedByUserId })
          .onConflictDoUpdate({
            target: systemSecret.key,
            set: { ...sealed, updatedAt: new Date(), updatedByUserId },
          });
        continue;
      }
      await transaction
        .insert(systemSetting)
        .values({ key, value: value as never, updatedByUserId })
        .onConflictDoUpdate({
          target: systemSetting.key,
          set: { value: value as never, updatedAt: new Date(), updatedByUserId },
        });
    }
  });
}

/** The stored secret settings among `keys` that cannot be decrypted, without throwing. */
async function unreadableSecretSettings(
  keys: readonly string[],
  database: typeof db,
): Promise<Set<string>> {
  const unreadable = new Set<string>();
  if (keys.length === 0) return unreadable;
  const rows = await database.select().from(systemSecret).where(inArray(systemSecret.key, keys));
  for (const row of rows) {
    try {
      decrypt(row, secretAad.systemSecret(row.key));
    } catch {
      unreadable.add(row.key);
    }
  }
  return unreadable;
}

/**
 * Every setting with its effective value and where it comes from, for the
 * administration. A secret is shown only as configured (`***`), never with
 * its value.
 */
export async function settingsView(database: typeof db = db): Promise<SettingsGroup[]> {
  // An invalid stored value is shown as its default and marked, so the
  // editor stays usable to replace it.
  const invalid = await invalidStoredSettings(database);
  const values = await resolveSettingValues(
    SETTING_DEFS.filter((def) => !def.secret && !invalid.has(def.key)).map((def) => def.key),
    { database },
  );
  for (const key of invalid) values[key] = settingDefinition(key).default;
  const storedRows = await database.select({ key: systemSetting.key }).from(systemSetting);
  const storedKeys = new Set(storedRows.map((row) => row.key));
  const storedSecrets = await storedSecretSettingKeys(database);
  // A stored secret in effect (no environment override) is checked against the
  // current key, so the editor can say when a restore brought it back without its key.
  const unreadable = await unreadableSecretSettings(
    SETTING_DEFS.filter(
      (def) =>
        def.secret && storedSecrets.has(def.key) && settingFromEnvironment(def) === undefined,
    ).map((def) => def.key),
    database,
  );

  const grouped: Record<string, ResolvedSetting[]> = {};
  for (const def of SETTING_DEFS) {
    const fromEnv = settingFromEnvironment(def) !== undefined;
    const stored = def.secret ? storedSecrets.has(def.key) : storedKeys.has(def.key);
    const source: SettingSource = fromEnv ? "env" : stored && !def.envOnly ? "database" : "default";
    let value: unknown;
    if (def.secret) value = fromEnv || stored ? "***" : "";
    else value = values[def.key];

    const groupSettings = grouped[def.group] ?? [];
    grouped[def.group] = groupSettings;
    groupSettings.push({
      group: def.group,
      subgroup: def.subgroup,
      key: def.key,
      label: def.label,
      description: def.description,
      type: def.type,
      options: def.options ? [...def.options] : undefined,
      secret: def.secret ?? false,
      value,
      source,
      envVar: settingEnvVar(def),
      // A setting only the environment sets is never editable here.
      envOverride: fromEnv || def.envOnly === true,
      showWhen: def.showWhen,
      ...(source === "database" && (unreadable.has(def.key) || invalid.has(def.key))
        ? { unreadable: true }
        : {}),
    });
  }

  return Object.entries(GROUP_LABELS).map(([id, label]) => ({
    id,
    label,
    settings: grouped[id] ?? [],
  }));
}

import { type PrivacySource, privacySourceSchema } from "@openmapx/core/privacy";
import { camelToUpperSnake } from "@openmapx/core/services/config-env-names";

/**
 * The registry of system settings. A setting key is dotted lowerCamel
 * segments, `<group>.<name>`; its environment variable, when the environment
 * may set it, is derived from the key by `settingEnvName`. The module has no
 * database dependency so the schema can build its key constraint from it.
 */

export type SettingType = "string" | "number" | "boolean" | "object" | "select";

export interface SettingDef {
  group: string;
  key: string;
  label: string;
  description?: string;
  type: SettingType;
  options?: readonly string[];
  secret?: boolean;
  /** The environment may set this setting, through `settingEnvName(key)`. */
  env?: boolean;
  /**
   * Only the environment sets this setting. It is never stored, and the
   * administration shows it without letting it be edited.
   */
  envOnly?: boolean;
  default: unknown;
  /**
   * Optional subgroup identifier. Settings sharing a subgroup render under a
   * common subheader on the client. Used in the Email panel to split the
   * SMTP / EmailLabs / Lettermint alternatives clearly.
   */
  subgroup?: string;
  /**
   * Show this setting only when another setting in the same group has a
   * matching value. Evaluated client-side against the current local form
   * state — lets a panel hide fields that don't apply to the current choice.
   */
  showWhen?: { key: string; equals: unknown | unknown[] };
  parse?: (raw: string) => unknown;
  validate?: (value: unknown) => boolean;
}

/**
 * The environment variable of a setting: the key's segments joined with `_`,
 * each camelCase word split, upper-cased. `email.fromAddress` becomes
 * `EMAIL_FROM_ADDRESS`.
 */
export function settingEnvName(key: string): string {
  return key.split(".").map(camelToUpperSnake).join("_");
}

/** The desired platform configuration, a versioned document kept beside the settings. */
export const PLATFORM_CONFIGURATION_SETTING = "platform.configuration";

export const SMTP_SECURITY_MODES = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number];

const validEmail = (value: unknown): boolean =>
  typeof value === "string" &&
  value.length <= 320 &&
  (value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
const boundedInteger =
  (min: number, max: number) =>
  (value: unknown): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const validJurisdiction = (value: unknown): boolean =>
  typeof value === "string" && (value === "" || /^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$/.test(value));
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const optionalSingleLine =
  (maxLength: number) =>
  (value: unknown): boolean =>
    typeof value === "string" &&
    value.length <= maxLength &&
    (value === "" || (value.trim().length > 0 && !hasControlCharacter(value)));
const validPhone = (value: unknown): boolean =>
  typeof value === "string" &&
  (value === "" ||
    (value.length <= 64 && value.trim().length > 0 && /^[+()0-9 .\-/]+$/.test(value)));
const validHttpUrl = (value: unknown): boolean => {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};
const parsePrivacySources = (raw: string): PrivacySource[] => {
  const parsed: unknown = JSON.parse(raw);
  return privacySourceSchema.array().parse(parsed);
};

export const SETTING_DEFS: readonly SettingDef[] = [
  // Authentication. The administration stores these as a pending draft; the
  // authentication policy applies them.
  {
    group: "auth",
    key: "auth.emailVerificationRequired",
    label: "Require Email Verification",
    description: "New users must verify their email before accessing the app.",
    type: "boolean",
    env: true,
    default: true,
  },
  {
    group: "auth",
    key: "auth.sessionDurationHours",
    validate: boundedInteger(1, 8760),
    label: "Session Duration (hours)",
    description: "Absolute lifetime of new sessions. Existing sessions keep their original expiry.",
    type: "number",
    default: 168,
  },
  {
    group: "auth",
    key: "auth.twoFaEnabled",
    label: "Enable Two-Factor Authentication",
    description: "Allow new TOTP enrollment. Existing second-factor challenges remain required.",
    type: "boolean",
    default: true,
  },
  {
    group: "auth",
    key: "auth.passwordMinLength",
    validate: boundedInteger(8, 128),
    label: "Minimum Password Length",
    type: "number",
    default: 8,
  },
  // Email — shared field used by every provider.
  {
    group: "email",
    subgroup: "common",
    key: "email.fromAddress",
    label: "From Address",
    description: "Used as the From header by every provider. e.g. noreply@example.com",
    type: "string",
    env: true,
    default: "",
  },
  // EmailLabs is used when all three fields are set, otherwise Lettermint,
  // then SMTP. See apps/api/src/utils/email.ts.
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emaillabs.appKey",
    label: "App Key",
    type: "string",
    secret: true,
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emaillabs.secretKey",
    label: "Secret Key",
    type: "string",
    secret: true,
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "emaillabs",
    key: "emaillabs.smtpAccount",
    label: "SMTP Account",
    type: "string",
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "lettermint",
    key: "lettermint.apiToken",
    label: "API Token",
    type: "string",
    secret: true,
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtp.host",
    label: "Host",
    type: "string",
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtp.port",
    label: "Port",
    type: "number",
    env: true,
    default: 587,
    validate: boundedInteger(1, 65535),
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtp.user",
    label: "Username",
    type: "string",
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtp.password",
    label: "Password",
    type: "string",
    secret: true,
    env: true,
    default: "",
  },
  {
    group: "email",
    subgroup: "smtp",
    key: "smtp.security",
    label: "Connection security",
    description:
      "STARTTLS (default, port 587) upgrades the connection and refuses to send without encryption; TLS (port 465) encrypts from the start; None sends unencrypted.",
    type: "select",
    options: SMTP_SECURITY_MODES,
    env: true,
    default: "starttls",
  },
  // Map
  {
    group: "map",
    key: "basemap.provider",
    label: "Hosted Vector Basemap",
    description:
      "Used only when self-hosted tiles are not configured or enabled. Auto uses MapTiler with a configured key, otherwise OpenFreeMap. Reload the map after saving.",
    type: "select",
    options: ["auto", "openfreemap", "maptiler"],
    env: true,
    default: "auto",
  },
  {
    group: "map",
    key: "maptiler.apiKey",
    label: "MapTiler API Key",
    description: "MapTiler Cloud API key for the built-in MapTiler tile and style proxy.",
    type: "string",
    secret: true,
    env: true,
    default: "",
  },
  // Data-use policy
  {
    group: "policy",
    key: "dataUse.allowNonCommercial",
    label: "Allow non-commercial-only sources",
    description:
      "When on (default), data sources whose licence forbids commercial use (e.g. Open-Meteo, RainViewer) are included. Turn off for a commercial deployment unless you hold commercial terms for them.",
    type: "boolean",
    env: true,
    default: true,
  },
  {
    group: "policy",
    key: "dataUse.allowGreyArea",
    label: "Allow grey-area / undocumented-terms sources",
    description:
      "When on (default), data sources with unclear or undocumented usage terms (e.g. unofficial or scraped APIs) are included — most are public APIs whose terms are merely undocumented. Turn off to exclude them (e.g. DB/HAFAS and the regional-transit registry).",
    type: "boolean",
    env: true,
    default: true,
  },
  // Legal pages — facts published on /privacy that vary by hosting setup,
  // read by the public /legal-config endpoint that the privacy page fetches.
  {
    group: "legal",
    subgroup: "operator",
    key: "legal.controller.name",
    label: "Controller name",
    description: "Legal name of the person or organization operating this instance.",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(200),
  },
  {
    group: "legal",
    subgroup: "operator",
    key: "legal.controller.street",
    label: "Street and house number",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(200),
  },
  {
    group: "legal",
    subgroup: "operator",
    key: "legal.controller.postalCode",
    label: "Postal code",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(32),
  },
  {
    group: "legal",
    subgroup: "operator",
    key: "legal.controller.city",
    label: "City",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(120),
  },
  {
    group: "legal",
    subgroup: "operator",
    key: "legal.controller.country",
    label: "Country",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(120),
  },
  {
    group: "legal",
    subgroup: "contact",
    key: "legal.controller.email",
    label: "Legal contact email",
    description: "Published contact address for the operator on legal pages.",
    type: "string",
    env: true,
    default: "",
    validate: validEmail,
  },
  {
    group: "legal",
    subgroup: "contact",
    key: "legal.controller.phone",
    label: "Legal contact phone",
    description: "Optional phone number published on the legal notice.",
    type: "string",
    env: true,
    default: "",
    validate: validPhone,
  },
  {
    group: "legal",
    subgroup: "contact",
    key: "legal.dataRequestEmail",
    label: "Data-subject request email",
    description:
      "Controller contact for access requests. Falls back to the legal contact email when unset.",
    type: "string",
    env: true,
    default: "",
    validate: validEmail,
  },
  {
    group: "legal",
    subgroup: "hosting",
    key: "legal.hosting.provider",
    label: "Hosting Provider",
    description:
      "Company that hosts this instance's servers. Named in the privacy policy's hosting section as the data processor (Art. 28 GDPR). Leave blank to omit that sentence.",
    type: "string",
    env: true,
    default: "",
  },
  {
    group: "legal",
    subgroup: "hosting",
    key: "legal.hosting.locations",
    label: "Hosting Data-Center Locations",
    description:
      'Where the hosting data centers are located (e.g. "Germany, Finland"). Appended to the hosting sentence on /privacy. Leave blank to omit.',
    type: "string",
    env: true,
    default: "",
  },
  {
    group: "legal",
    subgroup: "governance",
    key: "legal.supervisoryAuthority.name",
    label: "Data-Protection Supervisory Authority",
    description:
      "Name of the competent data-protection supervisory authority, shown in the privacy policy's GDPR-rights section. Leave blank to omit that sentence.",
    type: "string",
    env: true,
    default: "",
    validate: optionalSingleLine(300),
  },
  {
    group: "legal",
    subgroup: "governance",
    key: "legal.supervisoryAuthority.url",
    label: "Supervisory Authority URL",
    description:
      "Link to the supervisory authority named above. Rendered next to it on /privacy. Leave blank to show just the name.",
    type: "string",
    env: true,
    default: "",
    validate: validHttpUrl,
  },
  {
    group: "legal",
    subgroup: "governance",
    key: "legal.deploymentJurisdiction",
    label: "Deployment jurisdiction",
    description: "Informational ISO 3166-1 alpha-2 jurisdiction, optionally with a subdivision.",
    type: "string",
    env: true,
    default: "",
    validate: validJurisdiction,
  },
  {
    group: "legal",
    subgroup: "sources",
    key: "legal.privacySources",
    label: "Privacy sources",
    description: "Strict JSON source declarations used by the access report.",
    type: "object",
    env: true,
    default: [],
    parse: parsePrivacySources,
    validate: (value) =>
      Array.isArray(value) && privacySourceSchema.array().safeParse(value).success,
  },
  // Retention periods: every period the privacy page states has its home here.
  {
    group: "legal",
    subgroup: "retention",
    key: "retention.serverLogDays",
    label: "Server-Log Retention (days)",
    description:
      "How long persisted API warning/error logs are kept before automatic deletion. Infrastructure logs use the operator's separate policy. Defaults to 30.",
    type: "number",
    env: true,
    default: 30,
    validate: boundedInteger(1, 3650),
  },
  {
    group: "legal",
    subgroup: "retention",
    key: "retention.privacyCaseDays",
    label: "Privacy request case retention (days)",
    description: "How long closed data-subject request cases are kept. Defaults to 1095.",
    type: "number",
    env: true,
    default: 1095,
    validate: boundedInteger(30, 3650),
  },
  {
    group: "legal",
    subgroup: "retention",
    key: "retention.auditLogDays",
    label: "Administrator audit-log retention (days)",
    description: "How long administrator audit-log entries are kept. Defaults to 365.",
    type: "number",
    env: true,
    default: 365,
    validate: boundedInteger(1, 36_500),
  },
  {
    group: "legal",
    subgroup: "retention",
    key: "retention.adminJobDays",
    label: "Finished admin job retention (days)",
    description: "How long finished administrative jobs are kept. Defaults to 30.",
    type: "number",
    env: true,
    default: 30,
    validate: boundedInteger(1, 36_500),
  },
  {
    group: "legal",
    subgroup: "retention",
    key: "retention.backupDays",
    label: "Backup retention (days)",
    description:
      "How long local backups are kept. Set by the platform configuration, which the operations agent and the CLI share, so it cannot be changed here. Defaults to 30.",
    type: "number",
    envOnly: true,
    default: 30,
    validate: boundedInteger(1, 36_500),
  },
];

/** Keys a `system_setting` row may have: every stored non-secret setting and the platform configuration. */
export const STORED_SETTING_KEYS: readonly string[] = [
  ...SETTING_DEFS.filter((def) => !def.secret && !def.envOnly).map((def) => def.key),
  PLATFORM_CONFIGURATION_SETTING,
];

/** Keys a `system_secret` row may have. */
export const SECRET_SETTING_KEYS: readonly string[] = SETTING_DEFS.filter((def) => def.secret).map(
  (def) => def.key,
);

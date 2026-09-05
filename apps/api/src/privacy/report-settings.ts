import { type PrivacySource, privacySourceSchema } from "@openmapx/core/privacy";
import { db as defaultDb } from "../db/index.js";
import { systemSettings } from "../db/schema.js";

export interface PrivacyReportLegalFacts {
  controller: {
    name: string;
    address: string;
    email: string;
    phone: string | null;
  };
  deployment: {
    jurisdiction: string;
    supervisoryAuthority: string;
    supervisoryAuthorityUrl: string | null;
    privacySources: PrivacySource[];
    dsarCaseRetentionDays: number;
    identityEvidenceRetentionDays: number;
    exportArtifactRetentionHours: number;
  };
}

function clean(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function setting(
  envName: string,
  key: string,
  values: Record<string, unknown>,
  fallback: unknown,
  parseEnv: (raw: string) => unknown = (raw) => raw,
): unknown {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") return parseEnv(envValue);
  const databaseValue = values[key];
  if (databaseValue !== undefined) return databaseValue;
  return fallback;
}

function stringSetting(envName: string, key: string, values: Record<string, unknown>): string {
  return clean(setting(envName, key, values, ""));
}

function numberSetting(
  envName: string,
  key: string,
  values: Record<string, unknown>,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = setting(envName, key, values, fallback, Number);
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback;
}

function required(name: string, value: string): string {
  if (!value) throw new Error(`Missing privacy report legal configuration: ${name}`);
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function requiredSingleLine(name: string, value: string, maxLength: number): string {
  const result = required(name, value);
  if (result.length > maxLength || hasControlCharacter(result))
    throw new Error(`Invalid privacy report legal configuration: ${name}`);
  return result;
}

function optionalPhone(value: string): string | null {
  if (!value) return null;
  if (value.length > 64 || !/^[+()0-9 .\-/]+$/.test(value))
    throw new Error("Invalid privacy report legal configuration: controllerPhone");
  return value;
}

/** Canonical, secret-free legal facts used by response generation and release-evidence hashing. */
export async function resolvePrivacyReportLegalFacts(
  database: typeof defaultDb = defaultDb,
): Promise<PrivacyReportLegalFacts> {
  const rows = await database.select().from(systemSettings);
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const name = requiredSingleLine(
    "controllerName",
    stringSetting("LEGAL_NAME", "legalControllerName", values),
    200,
  );
  const street = requiredSingleLine(
    "controllerStreet",
    stringSetting("LEGAL_STREET", "legalControllerStreet", values),
    200,
  );
  const postalCode = requiredSingleLine(
    "controllerPostalCode",
    stringSetting("LEGAL_POSTAL_CODE", "legalControllerPostalCode", values),
    32,
  );
  const city = requiredSingleLine(
    "controllerCity",
    stringSetting("LEGAL_CITY", "legalControllerCity", values),
    120,
  );
  const country = requiredSingleLine(
    "controllerCountry",
    stringSetting("LEGAL_COUNTRY", "legalControllerCountry", values),
    120,
  );
  const controllerEmail = stringSetting("LEGAL_EMAIL", "legalControllerEmail", values);
  if (controllerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(controllerEmail))
    throw new Error("Invalid privacy report legal configuration: controllerEmail");
  const contact =
    stringSetting("LEGAL_DATA_REQUEST_EMAIL", "legalDataRequestEmail", values) || controllerEmail;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))
    throw new Error("Missing privacy report legal configuration: dataRequestEmail");
  const jurisdiction = required(
    "deploymentJurisdiction",
    stringSetting("LEGAL_DEPLOYMENT_JURISDICTION", "legalDeploymentJurisdiction", values),
  );
  if (!/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$/.test(jurisdiction))
    throw new Error("Invalid privacy report legal configuration: deploymentJurisdiction");
  const supervisoryAuthority = requiredSingleLine(
    "supervisoryAuthority",
    stringSetting("LEGAL_SUPERVISORY_AUTHORITY", "legalSupervisoryAuthority", values),
    300,
  );
  const authorityUrl = stringSetting(
    "LEGAL_SUPERVISORY_AUTHORITY_URL",
    "legalSupervisoryAuthorityUrl",
    values,
  );
  if (authorityUrl) {
    let parsedAuthorityUrl: URL;
    try {
      parsedAuthorityUrl = new URL(authorityUrl);
    } catch {
      throw new Error("Invalid privacy report legal configuration: supervisoryAuthorityUrl");
    }
    if (
      !["http:", "https:"].includes(parsedAuthorityUrl.protocol) ||
      parsedAuthorityUrl.username !== "" ||
      parsedAuthorityUrl.password !== ""
    )
      throw new Error("Invalid privacy report legal configuration: supervisoryAuthorityUrl");
  }
  const sourceRaw = setting("LEGAL_PRIVACY_SOURCES", "legalPrivacySources", values, []);
  let sourceValue: unknown = sourceRaw;
  if (typeof sourceRaw === "string") {
    try {
      sourceValue = JSON.parse(sourceRaw);
    } catch {
      throw new Error("Invalid privacy report legal configuration: privacySources");
    }
  }
  const sourceResult = privacySourceSchema.array().safeParse(sourceValue);
  if (!sourceResult.success)
    throw new Error("Invalid privacy report legal configuration: privacySources");
  return {
    controller: {
      name,
      address: `${street}\n${postalCode} ${city}\n${country}`,
      email: contact,
      phone: optionalPhone(stringSetting("LEGAL_PHONE", "legalControllerPhone", values)),
    },
    deployment: {
      jurisdiction,
      supervisoryAuthority,
      supervisoryAuthorityUrl: authorityUrl || null,
      privacySources: sourceResult.data,
      dsarCaseRetentionDays: numberSetting(
        "LEGAL_DSAR_CASE_RETENTION_DAYS",
        "legalDsarCaseRetentionDays",
        values,
        1095,
        30,
        3650,
      ),
      identityEvidenceRetentionDays: numberSetting(
        "LEGAL_IDENTITY_EVIDENCE_RETENTION_DAYS",
        "legalIdentityEvidenceRetentionDays",
        values,
        30,
        1,
        365,
      ),
      exportArtifactRetentionHours: numberSetting(
        "LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS",
        "legalExportArtifactRetentionHours",
        values,
        168,
        24,
        720,
      ),
    },
  };
}

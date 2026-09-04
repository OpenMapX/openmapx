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

function boundedInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function setting(
  envName: string,
  key: string,
  values: Record<string, unknown>,
  fallback: unknown,
): unknown {
  const env = process.env[envName];
  return env !== undefined && env !== "" ? env : (values[key] ?? fallback);
}

function required(name: string, value: string): string {
  if (!value) throw new Error(`Missing privacy report legal configuration: ${name}`);
  return value;
}

/** Canonical, secret-free legal facts used by response generation and release-evidence hashing. */
export async function resolvePrivacyReportLegalFacts(
  database: typeof defaultDb = defaultDb,
): Promise<PrivacyReportLegalFacts> {
  const rows = await database.select().from(systemSettings);
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const name = required("controllerName", clean(process.env.LEGAL_NAME));
  const street = required("controllerStreet", clean(process.env.LEGAL_STREET));
  const postalCode = required("controllerPostalCode", clean(process.env.LEGAL_POSTAL_CODE));
  const city = required("controllerCity", clean(process.env.LEGAL_CITY));
  const country = required("controllerCountry", clean(process.env.LEGAL_COUNTRY));
  const contact = clean(
    setting("LEGAL_DATA_REQUEST_EMAIL", "legalDataRequestEmail", values, process.env.LEGAL_EMAIL),
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))
    throw new Error("Missing privacy report legal configuration: dataRequestEmail");
  const jurisdiction = required(
    "deploymentJurisdiction",
    clean(setting("LEGAL_DEPLOYMENT_JURISDICTION", "legalDeploymentJurisdiction", values, "")),
  );
  if (!/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$/.test(jurisdiction))
    throw new Error("Invalid privacy report legal configuration: deploymentJurisdiction");
  const supervisoryAuthority = required(
    "supervisoryAuthority",
    clean(setting("LEGAL_SUPERVISORY_AUTHORITY", "legalSupervisoryAuthority", values, "")),
  );
  const authorityUrl = clean(
    setting("LEGAL_SUPERVISORY_AUTHORITY_URL", "legalSupervisoryAuthorityUrl", values, ""),
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
      phone: clean(process.env.LEGAL_PHONE) || null,
    },
    deployment: {
      jurisdiction,
      supervisoryAuthority,
      supervisoryAuthorityUrl: authorityUrl || null,
      privacySources: sourceResult.data,
      dsarCaseRetentionDays: boundedInteger(
        setting("LEGAL_DSAR_CASE_RETENTION_DAYS", "legalDsarCaseRetentionDays", values, 1095),
        1095,
        30,
        3650,
      ),
      identityEvidenceRetentionDays: boundedInteger(
        setting(
          "LEGAL_IDENTITY_EVIDENCE_RETENTION_DAYS",
          "legalIdentityEvidenceRetentionDays",
          values,
          30,
        ),
        30,
        1,
        365,
      ),
      exportArtifactRetentionHours: boundedInteger(
        setting(
          "LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS",
          "legalExportArtifactRetentionHours",
          values,
          168,
        ),
        168,
        24,
        720,
      ),
    },
  };
}

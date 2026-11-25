import type { PrivacySource } from "@openmapx/core/privacy";
import { db as defaultDb } from "../db/index.js";
import { retentionPeriods } from "../services/retention-settings.js";
import { resolveSettingValues, SettingValueError } from "../services/settings.js";

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
    /** Configured backup retention; backups are kept at most this long. */
    backupRetentionDays: number;
    /** Configured retention of persisted application logs. */
    serverLogRetentionDays: number;
    /** Configured retention of administrator audit-log entries. */
    auditLogRetentionDays: number;
    /** Configured retention of finished admin jobs. */
    adminJobRetentionDays: number;
  };
}

/** The operator has not configured the legal facts, or configured them wrongly.
 * Any other error, such as a database failure, is not this. */
export class PrivacyLegalConfigurationError extends Error {
  override name = "PrivacyLegalConfigurationError";
}

const LEGAL_REPORT_SETTINGS = {
  controllerName: "legal.controller.name",
  controllerStreet: "legal.controller.street",
  controllerPostalCode: "legal.controller.postalCode",
  controllerCity: "legal.controller.city",
  controllerCountry: "legal.controller.country",
  controllerEmail: "legal.controller.email",
  controllerPhone: "legal.controller.phone",
  dataRequestEmail: "legal.dataRequestEmail",
  deploymentJurisdiction: "legal.deploymentJurisdiction",
  supervisoryAuthority: "legal.supervisoryAuthority.name",
  supervisoryAuthorityUrl: "legal.supervisoryAuthority.url",
  privacySources: "legal.privacySources",
} as const;
type LegalReportFact = keyof typeof LEGAL_REPORT_SETTINGS;

/** Settings that resolve invalid are the operator's configuration problem. */
async function configured<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SettingValueError)
      throw new PrivacyLegalConfigurationError(
        `Invalid privacy report legal configuration: ${error.message}`,
      );
    throw error;
  }
}

/** Canonical, secret-free legal facts used by response generation. */
export async function resolvePrivacyReportLegalFacts(
  database: typeof defaultDb = defaultDb,
): Promise<PrivacyReportLegalFacts> {
  const facts = Object.keys(LEGAL_REPORT_SETTINGS) as LegalReportFact[];
  const values = await configured(() =>
    resolveSettingValues(
      facts.map((fact) => LEGAL_REPORT_SETTINGS[fact]),
      { database },
    ),
  );
  const periods = await configured(() => retentionPeriods({ database }));
  const text = (fact: LegalReportFact) => (values[LEGAL_REPORT_SETTINGS[fact]] as string).trim();
  const required = (fact: LegalReportFact) => {
    const value = text(fact);
    if (!value)
      throw new PrivacyLegalConfigurationError(
        `Missing privacy report legal configuration: ${fact}`,
      );
    return value;
  };

  const name = required("controllerName");
  const street = required("controllerStreet");
  const postalCode = required("controllerPostalCode");
  const city = required("controllerCity");
  const country = required("controllerCountry");
  const contact = text("dataRequestEmail") || text("controllerEmail");
  if (!contact)
    throw new PrivacyLegalConfigurationError(
      "Missing privacy report legal configuration: dataRequestEmail",
    );
  const jurisdiction = required("deploymentJurisdiction");
  const supervisoryAuthority = required("supervisoryAuthority");
  const phone = text("controllerPhone");
  return {
    controller: {
      name,
      address: `${street}\n${postalCode} ${city}\n${country}`,
      email: contact,
      phone: phone || null,
    },
    deployment: {
      jurisdiction,
      supervisoryAuthority,
      supervisoryAuthorityUrl: text("supervisoryAuthorityUrl") || null,
      privacySources: values[LEGAL_REPORT_SETTINGS.privacySources] as PrivacySource[],
      dsarCaseRetentionDays: periods.privacyCase,
      backupRetentionDays: periods.backup,
      serverLogRetentionDays: periods.serverLog,
      auditLogRetentionDays: periods.auditLog,
      adminJobRetentionDays: periods.adminJob,
    },
  };
}

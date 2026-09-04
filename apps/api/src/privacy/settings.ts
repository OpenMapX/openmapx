import { envString } from "@openmapx/core/server-env";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { systemSettings } from "../db/schema.js";

const retentionSettings = {
  artifact: {
    key: "legalExportArtifactRetentionHours",
    env: "LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS",
    fallback: 168,
    min: 24,
    max: 720,
  },
  case: {
    key: "legalDsarCaseRetentionDays",
    env: "LEGAL_DSAR_CASE_RETENTION_DAYS",
    fallback: 1095,
    min: 30,
    max: 3650,
  },
} as const;

/** Match the published settings' environment > database > default precedence. */
export async function privacyRetention(
  kind: keyof typeof retentionSettings,
  database: typeof defaultDb = defaultDb,
): Promise<number> {
  const setting = retentionSettings[kind];
  const env = envString(setting.env, "").trim();
  const rows = env
    ? []
    : await database
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, setting.key))
        .limit(1);
  const value = Number(env || rows[0]?.value || setting.fallback);
  if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max)
    throw new Error("Invalid privacy retention configuration");
  return value;
}

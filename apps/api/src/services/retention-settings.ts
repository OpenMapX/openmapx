import type { db } from "../db";
import { resolveSetting, resolveSettingValues } from "./settings";

/** The retention periods the privacy page states, each a setting in days. */
export type RetentionPeriod = "serverLog" | "privacyCase" | "auditLog" | "adminJob" | "backup";

const RETENTION_SETTINGS: Record<RetentionPeriod, string> = {
  serverLog: "retention.serverLogDays",
  privacyCase: "retention.privacyCaseDays",
  auditLog: "retention.auditLogDays",
  adminJob: "retention.adminJobDays",
  backup: "retention.backupDays",
};

/** Every retention period in days, as the settings resolve them now. */
export async function retentionPeriods(
  options: { database?: typeof db | null } = {},
): Promise<Record<RetentionPeriod, number>> {
  const periods = Object.keys(RETENTION_SETTINGS) as RetentionPeriod[];
  const values = await resolveSettingValues(
    periods.map((period) => RETENTION_SETTINGS[period]),
    options,
  );
  return Object.fromEntries(
    periods.map((period) => [period, values[RETENTION_SETTINGS[period]] as number]),
  ) as Record<RetentionPeriod, number>;
}

/** One retention period in days. */
export async function retentionDays(
  period: RetentionPeriod,
  options: { database?: typeof db | null } = {},
): Promise<number> {
  return (await resolveSetting(RETENTION_SETTINGS[period], options)) as number;
}

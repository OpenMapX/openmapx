import { createTranslator } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { SUBJECT_DATA_CATALOGUE_BY_ID } from "../../privacy/catalogue.js";
import { DECLARED_RETENTION_PERIODS } from "../declared-retention.js";

describe("declared retention periods", () => {
  const reasons = createTranslator("en", "privacyExport.report.retentionReasons");

  it.each(DECLARED_RETENTION_PERIODS)(
    "prunes $table after the period its catalogue entry $registrationId declares",
    ({ registrationId, days }) => {
      const registration = SUBJECT_DATA_CATALOGUE_BY_ID.get(registrationId);
      expect(registration, registrationId).toBeDefined();
      const retention = registration?.retention;
      if (retention?.kind === "fixed-days") {
        expect(retention.days).toBe(days);
        return;
      }
      // A record kept while its account or owner keeps it states its pruning
      // rule in the reason the export shows.
      expect(retention?.kind).toBe("account-lifetime");
      const reasonCode = retention?.reasonCode ?? "";
      expect(reasons.has(reasonCode), reasonCode).toBe(true);
      expect(reasons(reasonCode)).toContain(`${days} days`);
    },
  );

  it("keeps the offline-package rows of a deleted account for the period after closure", () => {
    const retention = SUBJECT_DATA_CATALOGUE_BY_ID.get("offline-package-ownership")?.retention;
    const days = DECLARED_RETENTION_PERIODS.filter(
      (period) => period.registrationId === "offline-package-ownership",
    ).map((period) => period.days);
    expect(days.length).toBeGreaterThan(0);
    expect(retention?.kind).toBe("account-lifetime");
    const afterClosure = retention && "daysAfterClosure" in retention && retention.daysAfterClosure;
    for (const value of days) expect(afterClosure).toBe(value);
  });
});

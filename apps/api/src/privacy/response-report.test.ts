import { messages } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { getCatalogueCopyWithFallbacks } from "./catalogue-copy.js";
import {
  buildPrivacyResponseReport,
  CONFIGURED_RETENTION,
  type PrivacyResponseContext,
} from "./response-report.js";

const context: PrivacyResponseContext = {
  request: {
    id: "request-123",
    kind: "access_and_portability",
    receivedAt: "2026-01-01T10:00:00.000Z",
    registeredAt: "2026-01-01T10:01:00.000Z",
    preservationAt: "2026-01-01T10:02:00.000Z",
    snapshotAt: "2026-01-01T10:03:00.000Z",
  },
  generatedAt: "2026-01-02T10:00:00.000Z",
  controller: {
    name: "Example & Maps GmbH",
    address: "Example <Street> 1\n10115 Berlin\nGermany",
    email: "privacy@example.test",
    phone: "+49 30 123",
  },
  deployment: {
    jurisdiction: "DE-BE",
    supervisoryAuthority: "Berlin data protection authority",
    supervisoryAuthorityUrl: "https://authority.example.test/complaints",
    privacySources: [
      {
        sourceId: "off-host-backup",
        kind: "operator",
        relationship: "controller-backup",
        location: "Encrypted EU object storage",
        retention: "Thirty rolling days",
        accessStrategy: "operator_task",
        instructionsCode: "backup-manual-restore",
      },
    ],
    dsarCaseRetentionDays: 1095,
    backupRetentionDays: 14,
    serverLogRetentionDays: 30,
    auditLogRetentionDays: 365,
    adminJobRetentionDays: 30,
  },
  reviewContact: "privacy@example.test (case request-123)",
  recipientSummary: {
    entries: [
      {
        recipientName: "Mail Processor Ltd",
        recipientRole: "processor",
        recipientCountry: "NL",
        lastOccurredAt: "2026-01-01T10:04:00.000Z",
        eventCount: 3,
        categoryCode: "email-delivery",
        purposeCode: "request-notification",
        legalBasisCode: "legal-obligation",
        transferSafeguardCode: null,
      },
    ],
    entryLimit: 1,
    truncated: true,
    totalGroupCount: 2,
    matchingEventCount: 4,
    archiveRecordCount: 4,
    summarizedAt: "2026-01-02T09:59:00.000Z",
    authoritativeSource: "openmapx-data-export/article-15/disclosures.jsonl",
  },
};

describe("localized privacy response report", () => {
  it("renders complete English text and escaped static HTML from the same facts", () => {
    const report = buildPrivacyResponseReport({
      locale: "en-US",
      context,
      sources: [
        {
          registrationId: "auth-sessions",
          category: "authentication",
          outcome: "omitted_with_reason",
          warningCodes: ["session-third-party-review"],
          capturedAt: "2026-01-01T10:03:30.000Z",
          recordCount: 2,
        },
      ],
    });

    for (const value of [
      "Example & Maps GmbH",
      "privacy@example.test",
      "2026-01-01T10:00:00.000Z",
      "access_and_portability",
      "session-third-party-review",
      "privacy@example.test (case request-123)",
      "Mail Processor Ltd",
      "article-15/disclosures.jsonl",
      "4 archived recipient events",
      "1 of 2 recipient groups",
      "summary is capped",
      "Berlin data protection authority",
      "judicial remedy",
      "withdraw consent",
      "solely automated decision",
      "independent controllers",
      "public networks",
      "off-host-backup",
      "30 days",
      "expiry of the session or confirmation",
      "Omitted after review",
      "Performance of the service contract",
      "An authorized caseworker recorded a source-specific limitation",
      "Case records are retained for 1,095 days",
      "Checked separately by the operator",
    ]) {
      expect(report.text.toLowerCase()).toContain(value.toLowerCase());
    }
    expect(report.text).not.toMatch(/download expires|identity evidence|download artifact/i);
    expect(report.html).toContain("default-src 'none'");
    expect(report.html).toContain("Example &amp; Maps GmbH");
    expect(report.html).toContain("Example &lt;Street&gt; 1");
    expect(report.html).not.toContain("<script");
    expect(report.html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(report.processingInformation.version).toBe(1);
    expect(report.processingInformation.recipientSummary).toMatchObject({
      truncated: true,
      totalGroupCount: 2,
      archiveRecordCount: 4,
    });
    expect(
      report.processingInformation.sources.find((source) => source.id === "auth-sessions"),
    ).toMatchObject({
      id: "auth-sessions",
      outcome: "omitted_with_reason",
      recordCount: 2,
    });
    // Operator-held sources are reported as checked separately, never as missing.
    expect(
      report.processingInformation.sources.find((source) => source.id === "application-logs"),
    ).toMatchObject({ outcome: "operator_check", warningCodes: [] });
    expect(report.processingInformation).not.toHaveProperty("expiresAt");
  });

  it("renders German canonical copy without losing exact case facts", () => {
    const report = buildPrivacyResponseReport({ locale: "de-DE", context, sources: [] });
    expect(report.text).toContain("Datenschutz");
    expect(report.text).toContain("Example & Maps GmbH");
    expect(report.text).toContain("request-123");
    expect(report.text).toContain("Wird vom Betreiber gesondert geprüft");
  });

  it("records a per-key English fallback used by catalogue report copy", () => {
    const entry = messages.de.privacyExport.catalogue.entries["auth-sessions"];
    const category = entry.category;
    try {
      delete (entry as Partial<typeof entry>).category;
      const report = buildPrivacyResponseReport({ locale: "de", context, sources: [] });
      expect(report.translationFallbacks).toContainEqual({
        key: "privacyExport.catalogue.entries.auth-sessions.category",
        reason: "missing",
        locale: "de",
        fallbackLocale: "en",
      });
    } finally {
      entry.category = category;
    }
  });

  it("names the short-lived catalogue categories that may have expired before collection", () => {
    const report = buildPrivacyResponseReport({ locale: "en", context, sources: [] });
    const shortLived = report.text.slice(
      report.text.indexOf("Short-lived data"),
      report.text.indexOf("Backups"),
    );
    const expected = [
      "auth-sessions",
      "auth-verifications",
      "auth-oauth-tokens",
      "mobile-auth-handoffs",
      "application-logs",
      "redis-subject-controls",
      "admin-jobs-attribution",
    ];
    for (const id of expected) {
      const registration = SUBJECT_DATA_CATALOGUE.find((entry) => entry.id === id);
      expect(registration, id).toBeDefined();
      expect(shortLived).toContain(getCatalogueCopyWithFallbacks("en", id).copy.category);
    }
    // Long-lived categories and retained backups are not listed as short-lived.
    expect(shortLived).not.toContain(
      getCatalogueCopyWithFallbacks("en", "account-profile").copy.category,
    );
    expect(shortLived).not.toContain(
      getCatalogueCopyWithFallbacks("en", "backup-retained-copies").copy.category,
    );
    expect(report.processingInformation.shortLivedCategories).toEqual(
      expect.arrayContaining(expected),
    );
    expect(report.processingInformation.shortLivedCategories).toHaveLength(expected.length);
    // Offline-package records live as long as the account; only the rows of a
    // deleted account follow a 30-day rule.
    expect(report.processingInformation.shortLivedCategories).not.toContain(
      "offline-package-ownership",
    );
  });

  it("states the retention this deployment configured, not the catalogue default", () => {
    for (const id of Object.keys(CONFIGURED_RETENTION))
      expect(SUBJECT_DATA_CATALOGUE.find((entry) => entry.id === id)?.retention.kind, id).toBe(
        "fixed-days",
      );
    const configured = {
      ...context,
      deployment: {
        ...context.deployment,
        auditLogRetentionDays: 730,
        adminJobRetentionDays: 60,
        serverLogRetentionDays: 14,
        dsarCaseRetentionDays: 400,
        backupRetentionDays: 21,
      },
    };
    const report = buildPrivacyResponseReport({ locale: "en", context: configured, sources: [] });
    const retentionOf = (id: string) =>
      report.processingInformation.sources.find((source) => source.id === id)?.retention;
    expect(retentionOf("admin-audit-attribution")).toMatchObject({
      days: 730,
      daysAfterClosure: 730,
    });
    expect(retentionOf("admin-jobs-attribution")).toMatchObject({ days: 60 });
    expect(retentionOf("application-logs")).toMatchObject({ days: 14 });
    expect(retentionOf("privacy-case-records")).toMatchObject({ days: 400 });
    expect(retentionOf("privacy-case-handling-attribution")).toMatchObject({ days: 400 });
    expect(retentionOf("backup-retained-copies")).toMatchObject({ days: 21 });
    // A 60-day job record no longer counts as short-lived; 14-day logs do.
    expect(report.processingInformation.shortLivedCategories).not.toContain(
      "admin-jobs-attribution",
    );
    expect(report.processingInformation.shortLivedCategories).toContain("application-logs");
    expect(report.text).toContain("730 days from the applicable record event");
  });

  it("states that a pending extension erasure is kept from account closure until it is done", () => {
    const expected = {
      en: "Only from account closure until the recorded erasure is done, with no fixed period and no legal hold; policy trigger: erasure by the extension that holds the data, or removal of that extension's data",
      de: "Nur ab der Kontoschließung, bis die vermerkte Löschung erledigt ist, ohne feste Frist und ohne rechtliche Aufbewahrung; Richtlinienauslöser: Löschung durch die Erweiterung, die die Daten hält, oder Entfernen der Daten dieser Erweiterung",
    };
    for (const locale of ["en", "de"] as const) {
      const report = buildPrivacyResponseReport({ locale, context, sources: [] });
      const row = report.text
        .split("\n")
        .find((line) => line.startsWith("extension-erasure-pending"));
      expect(row, locale).toContain(expected[locale]);
      expect(
        report.processingInformation.sources.find(
          (source) => source.id === "extension-erasure-pending",
        )?.retention,
      ).toEqual({ kind: "until-erased", reasonCode: "extension-erasure" });
    }
  });

  it("states the backup policy with the configured retention and the request contact", () => {
    for (const locale of ["en", "de"] as const) {
      const report = buildPrivacyResponseReport({ locale, context, sources: [] });
      const t = messages[locale].privacyExport.report;
      expect(report.text).toContain(t.backupHeading);
      const statement = report.text.slice(report.text.indexOf(t.backupHeading));
      expect(statement).toContain("14");
      expect(statement).toContain("privacy@example.test");
    }
    const english = buildPrivacyResponseReport({ locale: "en", context, sources: [] }).text;
    expect(english).toContain("only to recover from failure");
    expect(english).toContain("erasure journal");
  });

  it("lists every extension that could not be asked, with its reason", () => {
    const extensions = [
      {
        integrationId: "acme-overlay",
        name: "Acme overlay",
        outcome: "included" as const,
        warningCode: null,
      },
      {
        integrationId: "acme-tracker",
        name: "Acme tracker",
        outcome: "unavailable" as const,
        warningCode: "extension-not-loaded",
      },
      {
        integrationId: "acme-broken",
        name: "Acme broken",
        outcome: "unavailable" as const,
        warningCode: "extension-handler-failed",
      },
    ];
    for (const locale of ["en", "de"] as const) {
      const t = messages[locale].privacyExport.report;
      const report = buildPrivacyResponseReport({ locale, context, sources: [], extensions });
      const section = report.text.slice(report.text.indexOf(t.extensionsUnavailableHeading));
      expect(report.text).toContain(t.extensionsUnavailableHeading);
      expect(section).toContain(
        `- Acme tracker (acme-tracker): ${t.warnings["extension-not-loaded"]}`,
      );
      expect(section).toContain(
        `- Acme broken (acme-broken): ${t.warnings["extension-handler-failed"]}`,
      );
      expect(section).not.toContain("acme-overlay");
      expect(report.processingInformation.extensions).toEqual(extensions);
    }
    expect(buildPrivacyResponseReport({ locale: "en", context, sources: [] }).text).not.toContain(
      "Extensions that could not be asked",
    );
  });
});

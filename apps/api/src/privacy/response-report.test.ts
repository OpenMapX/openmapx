import { messages } from "@openmapx/i18n";
import { describe, expect, it } from "vitest";
import { buildPrivacyResponseReport, type PrivacyResponseContext } from "./response-report.js";

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
  expiresAt: "2026-01-09T10:00:00.000Z",
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
        instructionsCode: "backup-review",
      },
    ],
    dsarCaseRetentionDays: 1095,
    identityEvidenceRetentionDays: 30,
    exportArtifactRetentionHours: 168,
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
      "2026-01-09T10:00:00.000Z",
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
      "security retention period",
      "Omitted after review",
      "Performance of the service contract",
      "An authorized caseworker recorded a source-specific limitation",
      "Case records are retained for 1,095 days",
    ]) {
      expect(report.text.toLowerCase()).toContain(value.toLowerCase());
    }
    expect(report.html).toContain("default-src 'none'");
    expect(report.html).toContain("Example &amp; Maps GmbH");
    expect(report.html).toContain("Example &lt;Street&gt; 1");
    expect(report.html).not.toContain("<script");
    expect(report.html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(report.processingInformation.version).toBe(2);
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
  });

  it("renders German canonical copy without losing exact case facts", () => {
    const report = buildPrivacyResponseReport({ locale: "de-DE", context, sources: [] });
    expect(report.text).toContain("Datenschutz");
    expect(report.text).toContain("Example & Maps GmbH");
    expect(report.text).toContain("request-123");
    expect(report.text).toContain("2026-01-09T10:00:00.000Z");
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
});

import type { PrivacySource } from "@openmapx/core/privacy";
import { createTranslator, type Locale, resolveLocale } from "@openmapx/i18n";
import { SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import { getCatalogueCopyWithFallbacks } from "./catalogue-copy.js";

type ReportTranslator = ReturnType<typeof createTranslator>;

export type PrivacyRequestKind = "access" | "portability" | "access_and_portability";

export interface PrivacyResponseContext {
  request: {
    id: string;
    kind: PrivacyRequestKind;
    receivedAt: string;
    registeredAt: string;
    preservationAt: string | null;
    snapshotAt: string;
  };
  generatedAt: string;
  expiresAt: string;
  controller: { name: string; address: string; email: string; phone: string | null };
  deployment: {
    jurisdiction: string;
    supervisoryAuthority: string;
    supervisoryAuthorityUrl: string | null;
    privacySources: PrivacySource[];
    dsarCaseRetentionDays: number;
    identityEvidenceRetentionDays: number;
    exportArtifactRetentionHours: number;
  };
  reviewContact: string;
  recipientSummary: {
    entries: Array<{
      recipientName: string;
      recipientRole: string;
      recipientCountry: string | null;
      lastOccurredAt: string;
      eventCount: number;
      categoryCode: string;
      purposeCode: string;
      legalBasisCode: string;
      transferSafeguardCode: string | null;
    }>;
    entryLimit: number;
    truncated: boolean;
    totalGroupCount: number;
    matchingEventCount: number;
    archiveRecordCount: number;
    summarizedAt: string;
    authoritativeSource: string;
  };
}

export interface PrivacyReportSource {
  registrationId: string;
  category: string;
  outcome: string;
  warningCodes: readonly string[];
  capturedAt: string;
  recordCount: number;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

function iso(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw new Error(`Invalid privacy response timestamp: ${field}`);
  return value;
}

function reportRights(kind: PrivacyRequestKind): { access: boolean; portability: boolean } {
  return {
    access: kind === "access" || kind === "access_and_portability",
    portability: kind === "portability" || kind === "access_and_portability",
  };
}

function codeLabel(t: ReportTranslator, group: string, code: string): string {
  const key = `${group}.${code}`;
  return t.has(key) ? t(key) : t("recordedCode", { code });
}

function retentionText(
  t: ReportTranslator,
  rule: (typeof SUBJECT_DATA_CATALOGUE)[number]["retention"],
): string {
  const trigger = rule.reasonCode
    ? codeLabel(t, "retentionReasons", rule.reasonCode)
    : t("notRecorded");
  if (rule.kind === "fixed-days")
    return t("retentionFixed", {
      days: rule.days,
      afterClosure: rule.daysAfterClosure,
      trigger,
    });
  if (rule.kind === "ephemeral")
    return t("retentionEphemeral", {
      hours: rule.hours,
      afterClosure: rule.daysAfterClosure,
      trigger,
    });
  if (rule.kind === "account-lifetime")
    return t("retentionAccount", { afterClosure: rule.daysAfterClosure, trigger });
  return t("retentionLegalHold", { afterClosure: rule.daysAfterClosure, trigger });
}

export function buildPrivacyResponseReport(input: {
  locale: string;
  context: PrivacyResponseContext;
  sources: readonly PrivacyReportSource[];
}) {
  const locale = resolveLocale(input.locale);
  const t = createTranslator(locale, "privacyExport.report");
  const { context } = input;
  for (const [field, value] of Object.entries({
    receivedAt: context.request.receivedAt,
    registeredAt: context.request.registeredAt,
    preservationAt: context.request.preservationAt,
    snapshotAt: context.request.snapshotAt,
    generatedAt: context.generatedAt,
    expiresAt: context.expiresAt,
    summarizedAt: context.recipientSummary.summarizedAt,
  }))
    iso(value, field);
  for (const recipient of context.recipientSummary.entries)
    iso(recipient.lastOccurredAt, "recipientSummary.lastOccurredAt");
  const rights = reportRights(context.request.kind);
  const reportedRecipientSummary = rights.access ? context.recipientSummary : null;
  const scopeKey =
    rights.access && rights.portability
      ? "scopeCombined"
      : rights.access
        ? "scopeAccess"
        : "scopePortability";
  const lines = [
    t("title"),
    "",
    t("intro", { requestId: context.request.id }),
    "",
    t("controllerHeading"),
    context.controller.name,
    context.controller.address,
    `${t("emailLabel")}: ${context.controller.email}`,
    ...(context.controller.phone ? [`${t("phoneLabel")}: ${context.controller.phone}`] : []),
    `${t("jurisdictionLabel")}: ${context.deployment.jurisdiction}`,
    "",
    t("requestHeading"),
    `${t("requestIdLabel")}: ${context.request.id}`,
    `${t("requestKindLabel")}: ${codeLabel(t, "requestKinds", context.request.kind)} (${context.request.kind})`,
    t(scopeKey),
    `${t("receivedAtLabel")}: ${context.request.receivedAt}`,
    `${t("registeredAtLabel")}: ${context.request.registeredAt}`,
    `${t("preservationAtLabel")}: ${context.request.preservationAt ?? t("notRecorded")}`,
    `${t("snapshotAtLabel")}: ${context.request.snapshotAt}`,
    `${t("generatedAtLabel")}: ${context.generatedAt}`,
    `${t("expiresAtLabel")}: ${context.expiresAt}`,
    t("caseRetention", {
      caseDays: context.deployment.dsarCaseRetentionDays,
      identityDays: context.deployment.identityEvidenceRetentionDays,
      artifactHours: context.deployment.exportArtifactRetentionHours,
    }),
    t("snapshotLimitations"),
    "",
    t("sourcesHeading"),
  ];
  const catalogueFallbacks: ReturnType<typeof t.fallbacks> = [];
  const processingSources = SUBJECT_DATA_CATALOGUE.filter(
    (registration) => rights.access || registration.portability.decision === "include",
  ).map((registration) => {
    const observed = input.sources.find((source) => source.registrationId === registration.id);
    const explanation = getCatalogueCopyWithFallbacks(locale, registration.id);
    catalogueFallbacks.push(...explanation.translationFallbacks);
    return {
      id: registration.id,
      version: registration.version,
      category: registration.category,
      explanation: explanation.copy,
      source: registration.source,
      strategy: registration.strategy,
      purposes: registration.purposes,
      legalBases: registration.legalBases,
      origin: registration.origin,
      retention: registration.retention,
      recipients: registration.recipients,
      article15: registration.article15,
      portability: registration.portability,
      secretPolicy: registration.secretPolicy,
      rightsOfOthers: registration.rightsOfOthers,
      outcome:
        observed?.outcome ??
        (registration.strategy === "not_personal" ? "not_applicable" : "unavailable"),
      capturedAt: observed?.capturedAt ?? null,
      recordCount: observed?.recordCount ?? 0,
      warningCodes:
        observed?.warningCodes ??
        (registration.strategy === "not_personal" ? [] : ["source-not-collected"]),
    };
  });
  for (const source of processingSources) {
    const copy = source.explanation;
    lines.push(
      t("sourceRow", {
        id: source.id,
        category: copy.category,
        outcome: codeLabel(t, "outcomes", source.outcome),
        count: source.recordCount,
        capturedAt: source.capturedAt ?? t("notRecorded"),
        purposes: source.purposes.map((code) => codeLabel(t, "purposes", code)).join(", "),
        legalBases: source.legalBases.map((code) => codeLabel(t, "legalBases", code)).join(", "),
        origin: `${codeLabel(t, "origins", source.origin.kind)} — ${copy.source}`,
        retention: retentionText(t, source.retention),
      }),
      t("sourcePolicy", {
        purpose: copy.purpose,
        source: copy.source,
        safeRepresentation: copy.safeRepresentation,
        portability: copy.portabilityExclusion,
        rightsOfOthers: copy.rightsOfOthers,
      }),
      t("sourceRecipients", {
        recipients:
          source.recipients
            .map((recipient) => {
              const name =
                recipient.id === "openmapx-controller"
                  ? context.controller.name
                  : codeLabel(t, "recipientNames", recipient.id);
              const country =
                recipient.country ??
                (recipient.id === "openmapx-controller"
                  ? context.deployment.jurisdiction
                  : t("notRecorded"));
              return t("sourceRecipient", {
                name,
                role: codeLabel(t, "recipientRoles", recipient.roleCode),
                country,
                safeguard: recipient.transferSafeguardCode
                  ? codeLabel(t, "transferSafeguards", recipient.transferSafeguardCode)
                  : t("notApplicable"),
              });
            })
            .join("; ") || t("notApplicable"),
      }),
    );
    if (source.warningCodes.length)
      lines.push(
        t("sourceWarnings", {
          codes: source.warningCodes
            .map((code) =>
              t("warningExplanation", {
                code,
                explanation: t.has(`warnings.${code}`)
                  ? t(`warnings.${code}`)
                  : t("warningUnknown", { contact: context.reviewContact }),
              }),
            )
            .join("; "),
        }),
      );
  }
  lines.push("", t("deploymentSourcesHeading"));
  if (!context.deployment.privacySources.length) lines.push(t("noDeploymentSources"));
  for (const source of context.deployment.privacySources)
    lines.push(
      t("deploymentSourceRow", {
        id: source.sourceId,
        kind: source.kind,
        relationship: source.relationship,
        location: source.location,
        retention: source.retention,
        accessStrategy: source.accessStrategy,
      }),
    );
  lines.push("", t("recipientsHeading"));
  if (!reportedRecipientSummary) {
    lines.push(t("recipientsNotInScope"));
  } else {
    lines.push(
      t("recipientSummary", {
        archiveRecordCount: reportedRecipientSummary.archiveRecordCount,
        summarizedAt: reportedRecipientSummary.summarizedAt,
        shownGroupCount: reportedRecipientSummary.entries.length,
        totalGroupCount: reportedRecipientSummary.totalGroupCount,
        matchingEventCount: reportedRecipientSummary.matchingEventCount,
        entryLimit: reportedRecipientSummary.entryLimit,
      }),
      t(
        reportedRecipientSummary.truncated
          ? "recipientSummaryTruncated"
          : "recipientSummaryComplete",
      ),
    );
  }
  if (reportedRecipientSummary && !reportedRecipientSummary.archiveRecordCount)
    lines.push(t("noActualRecipients"));
  for (const recipient of reportedRecipientSummary?.entries ?? [])
    lines.push(
      t("recipientRow", {
        name: recipient.recipientName,
        role: codeLabel(t, "recipientRoles", recipient.recipientRole),
        country: recipient.recipientCountry ?? t("notRecorded"),
        lastOccurredAt: recipient.lastOccurredAt,
        eventCount: recipient.eventCount,
        category: recipient.categoryCode,
        purpose: codeLabel(t, "purposes", recipient.purposeCode),
        legalBasis: codeLabel(t, "legalBases", recipient.legalBasisCode),
        safeguard: recipient.transferSafeguardCode ?? t("notApplicable"),
      }),
    );
  if (reportedRecipientSummary)
    lines.push(t("recipientPointer", { source: reportedRecipientSummary.authoritativeSource }));
  lines.push(
    "",
    t("rightsHeading"),
    t("rights"),
    t("complaint", {
      authority: context.deployment.supervisoryAuthority,
      url: context.deployment.supervisoryAuthorityUrl ?? t("notRecorded"),
    }),
    t("reviewContact", { contact: context.reviewContact }),
    "",
    t("automationHeading"),
    t("automation"),
    "",
    t("boundariesHeading"),
    t("boundaries"),
  );
  const text = `${lines.join("\n")}\n`;
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(t("title"))}</title><style>body{font:16px/1.5 system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>${escapeHtml(text)}</body></html>`;
  const translationFallbacks = [
    ...new Map(
      [...t.fallbacks(), ...catalogueFallbacks].map((fallback) => [fallback.key, fallback]),
    ).values(),
  ];
  return {
    text,
    html,
    translationFallbacks,
    processingInformation: {
      version: 2 as const,
      request: { ...context.request, rights },
      controller: context.controller,
      deployment: context.deployment,
      generatedAt: context.generatedAt,
      expiresAt: context.expiresAt,
      reviewContact: context.reviewContact,
      recipientSummary: reportedRecipientSummary,
      translationFallbacks,
      sources: processingSources,
    },
  };
}

export function responseReportLocale(locale: string): Locale {
  return resolveLocale(locale);
}

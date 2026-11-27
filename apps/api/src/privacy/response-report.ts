import type { PrivacySource } from "@openmapx/core/privacy";
import { createTranslator, type Locale, resolveLocale } from "@openmapx/i18n";
import { type SUBJECT_DATA_CATALOGUE, subjectDataCatalogue } from "./catalogue.js";
import { getCatalogueCopyWithFallbacks } from "./catalogue-copy.js";
import { EXTENSION_LOGICAL_ID_PREFIX } from "./extension-handlers.js";

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
  controller: { name: string; address: string; email: string; phone: string | null };
  deployment: {
    jurisdiction: string;
    supervisoryAuthority: string;
    supervisoryAuthorityUrl: string | null;
    privacySources: PrivacySource[];
    dsarCaseRetentionDays: number;
    backupRetentionDays: number;
    serverLogRetentionDays: number;
    auditLogRetentionDays: number;
    adminJobRetentionDays: number;
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

/** What asking one extension's subject-data handler gave. */
export interface PrivacyReportExtension {
  integrationId: string;
  name: string;
  outcome: "included" | "unavailable";
  warningCode: string | null;
}

/**
 * The source that answered for a registration: an extension's registration
 * is answered by the part of the extension that declared it.
 */
function observedSource(
  registration: Registration,
  sources: readonly PrivacyReportSource[],
): PrivacyReportSource | undefined {
  const { collectorId } = registration;
  const registrationId =
    registration.source === "extension" && collectorId?.startsWith("extension:")
      ? `${EXTENSION_LOGICAL_ID_PREFIX}${collectorId.slice("extension:".length)}`
      : registration.id;
  return sources.find((source) => source.registrationId === registrationId);
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

/** Categories kept for at most the regular one-month response period may have
 * expired between receipt and collection. */
const SHORT_LIVED_RETENTION_DAYS = 30;

type Registration = (typeof SUBJECT_DATA_CATALOGUE)[number];
type RetentionRule = Registration["retention"];

/**
 * Registrations whose period an operator configures. The catalogue holds the
 * default; the report states the period this deployment actually enforces.
 */
export const CONFIGURED_RETENTION: Readonly<
  Record<string, (deployment: PrivacyResponseContext["deployment"]) => number>
> = {
  "admin-audit-attribution": (deployment) => deployment.auditLogRetentionDays,
  "admin-jobs-attribution": (deployment) => deployment.adminJobRetentionDays,
  "application-logs": (deployment) => deployment.serverLogRetentionDays,
  "privacy-case-records": (deployment) => deployment.dsarCaseRetentionDays,
  "privacy-case-handling-attribution": (deployment) => deployment.dsarCaseRetentionDays,
  "backup-retained-copies": (deployment) => deployment.backupRetentionDays,
};

function effectiveRetention(
  registration: Registration,
  deployment: PrivacyResponseContext["deployment"],
): RetentionRule {
  const configured = CONFIGURED_RETENTION[registration.id];
  const rule = registration.retention;
  if (!configured || rule.kind !== "fixed-days") return rule;
  const days = configured(deployment);
  return { ...rule, days, daysAfterClosure: days };
}

function retentionDays(rule: RetentionRule): number | null {
  if (rule.kind === "fixed-days") return rule.days;
  if (rule.kind === "ephemeral") return rule.hours / 24;
  return null;
}

function isShortLived(
  registration: Registration,
  deployment: PrivacyResponseContext["deployment"],
): boolean {
  const days = retentionDays(effectiveRetention(registration, deployment));
  return (
    registration.strategy !== "not_personal" &&
    // Retained backups have their own statement in the report.
    registration.category !== "backup-copies" &&
    days !== null &&
    days <= SHORT_LIVED_RETENTION_DAYS
  );
}

function codeLabel(t: ReportTranslator, group: string, code: string): string {
  const key = `${group}.${code}`;
  return t.has(key) ? t(key) : t("recordedCode", { code });
}

function retentionText(t: ReportTranslator, rule: RetentionRule): string {
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
  extensions?: readonly PrivacyReportExtension[];
}) {
  const locale = resolveLocale(input.locale);
  const extensions = input.extensions ?? [];
  const t = createTranslator(locale, "privacyExport.report");
  const { context } = input;
  for (const [field, value] of Object.entries({
    receivedAt: context.request.receivedAt,
    registeredAt: context.request.registeredAt,
    preservationAt: context.request.preservationAt,
    snapshotAt: context.request.snapshotAt,
    generatedAt: context.generatedAt,
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
    t("caseRetention", { caseDays: context.deployment.dsarCaseRetentionDays }),
    t("snapshotLimitations"),
  ];
  const catalogueFallbacks: ReturnType<typeof t.fallbacks> = [];
  const scopedRegistrations = subjectDataCatalogue().filter(
    (registration) => rights.access || registration.portability.decision === "include",
  );
  const shortLived = scopedRegistrations.filter((registration) =>
    isShortLived(registration, context.deployment),
  );
  lines.push("", t("shortLivedHeading"), t("shortLivedIntro"));
  for (const registration of shortLived) {
    const copy = getCatalogueCopyWithFallbacks(locale, registration.id);
    catalogueFallbacks.push(...copy.translationFallbacks);
    lines.push(
      t("shortLivedRow", {
        id: registration.id,
        category: copy.copy.category,
        retention: retentionText(t, effectiveRetention(registration, context.deployment)),
      }),
    );
  }
  lines.push(
    "",
    t("backupHeading"),
    t("backupStatement", {
      days: context.deployment.backupRetentionDays,
      contact: context.controller.email,
    }),
    "",
    t("sourcesHeading"),
  );
  const processingSources = scopedRegistrations.map((registration) => {
    const observed = observedSource(registration, input.sources);
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
      retention: effectiveRetention(registration, context.deployment),
      recipients: registration.recipients,
      article15: registration.article15,
      portability: registration.portability,
      secretPolicy: registration.secretPolicy,
      rightsOfOthers: registration.rightsOfOthers,
      // Operator-held sources are never collected automatically: the report
      // names them as checked separately by the operator.
      outcome:
        observed?.outcome ??
        (registration.strategy === "not_personal"
          ? "not_applicable"
          : registration.strategy === "operator_task"
            ? "operator_check"
            : "unavailable"),
      capturedAt: observed?.capturedAt ?? null,
      recordCount: observed?.recordCount ?? 0,
      warningCodes:
        observed?.warningCodes ??
        (registration.strategy === "collector" ? ["source-not-collected"] : []),
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
  const unasked = extensions.filter((extension) => extension.outcome === "unavailable");
  if (unasked.length) {
    lines.push("", t("extensionsUnavailableHeading"), t("extensionsUnavailableIntro"));
    for (const extension of unasked)
      lines.push(
        t("extensionUnavailableRow", {
          name: extension.name,
          id: extension.integrationId,
          reason:
            extension.warningCode && t.has(`warnings.${extension.warningCode}`)
              ? t(`warnings.${extension.warningCode}`)
              : t("warningUnknown", { contact: context.reviewContact }),
        }),
      );
    lines.push(t("reviewContact", { contact: context.reviewContact }));
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
      version: 1 as const,
      request: { ...context.request, rights },
      controller: context.controller,
      deployment: context.deployment,
      generatedAt: context.generatedAt,
      reviewContact: context.reviewContact,
      recipientSummary: reportedRecipientSummary,
      translationFallbacks,
      shortLivedCategories: shortLived.map((registration) => registration.id),
      sources: processingSources,
      extensions: extensions.map(({ integrationId, name, outcome, warningCode }) => ({
        integrationId,
        name,
        outcome,
        warningCode,
      })),
    },
  };
}

export function responseReportLocale(locale: string): Locale {
  return resolveLocale(locale);
}

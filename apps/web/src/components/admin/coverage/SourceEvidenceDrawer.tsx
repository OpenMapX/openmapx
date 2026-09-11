"use client";

import CloseIcon from "@mui/icons-material/Close";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { safeHref } from "@openmapx/core";
import type {
  CoverageSourceDetail,
  CoverageSourceRow,
  UsageAssessment,
} from "@openmapx/core/coverage";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { type CoverageRequestError, useCoverageSource } from "@/lib/admin/coverageHooks";
import { CompactAlert } from "../shared/CompactAlert";
import { CoverageStatus, formatCoverageDate } from "./CoverageStatus";

export function SourceEvidenceDrawer({
  source,
  sourceKey,
  regionId,
  snapshotId,
  assessment,
  onClose,
  onSnapshotExpired,
}: {
  source: CoverageSourceRow | null;
  sourceKey?: string;
  regionId: string;
  snapshotId?: string;
  assessment: UsageAssessment;
  onClose: () => void;
  onSnapshotExpired?: () => void;
}) {
  const t = useTranslations("adminCoverage");
  const key = source?.key ?? sourceKey ?? "";
  const query = useCoverageSource(key ? { key, regionId, snapshotId, assessment } : null);
  const data = query.data;
  const displayedSource = data?.source ?? source;
  const handledSnapshotExpiry = useRef(false);
  const snapshotExpired =
    query.isError && (query.error as CoverageRequestError).code === "snapshot_expired";

  useEffect(() => {
    if (!snapshotExpired) {
      handledSnapshotExpiry.current = false;
      return;
    }
    if (handledSnapshotExpiry.current) return;
    handledSnapshotExpiry.current = true;
    (onSnapshotExpired ?? onClose)();
  }, [onClose, onSnapshotExpired, snapshotExpired]);
  return (
    <Drawer
      anchor="right"
      open={Boolean(key)}
      onClose={onClose}
      ModalProps={{ keepMounted: true }}
      aria-labelledby="coverage-source-drawer-title"
      slotProps={{ paper: { sx: { width: { xs: "100%", sm: 480 }, maxWidth: "100vw" } } }}
    >
      <Stack sx={{ height: "100%", overflowY: "auto", p: 2, gap: 2 }}>
        <Stack direction="row" sx={{ alignItems: "flex-start", gap: 1 }}>
          <Stack sx={{ minWidth: 0, flex: 1, gap: 0.25 }}>
            <Typography id="coverage-source-drawer-title" component="h2" variant="h6">
              {displayedSource?.name ?? t("sourceDrawer.title")}
            </Typography>
            {displayedSource && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: "anywhere" }}
              >
                {displayedSource.key}
              </Typography>
            )}
          </Stack>
          <IconButton onClick={onClose} aria-label={t("common.close")} autoFocus>
            <CloseIcon />
          </IconButton>
        </Stack>

        {query.isLoading && <Typography color="text.secondary">{t("common.loading")}</Typography>}
        {query.isError && (
          <CompactAlert severity="error">
            {snapshotExpired ? t("snapshot.expired") : t("sourceDrawer.loadError")}
          </CompactAlert>
        )}
        {data && <SourceEvidenceBody data={data} assessment={assessment} />}
      </Stack>
    </Drawer>
  );
}

function SourceEvidenceBody({
  data,
  assessment,
}: {
  data: CoverageSourceDetail;
  assessment: UsageAssessment;
}) {
  const t = useTranslations("adminCoverage");
  const source = data.source;
  return (
    <Stack spacing={2}>
      {data.warnings.length > 0 && (
        <CompactAlert severity="warning">
          {data.warnings.map((warning) => t(`reason.${warning}`)).join(" · ")}
        </CompactAlert>
      )}

      <Section title={t("sourceDrawer.identity")}>
        <Detail
          label={t("sourceDrawer.owner")}
          value={`${source.owner.kind}: ${source.owner.id}`}
        />
        <Detail label={t("sourceDrawer.sourceId")} value={source.sourceId} />
        <Detail label={t("sourceDrawer.domain")} value={t(`domain.${source.domain}`)} />
        <Detail label={t("sourceDrawer.stream")} value={source.stream} />
        <Detail label={t("sourceDrawer.evidenceKey")} value={source.key} />
        <Detail
          label={t("sourceDrawer.consumer")}
          value={data.evidence.consumerInstance ?? t("common.unknown")}
        />
        <Detail
          label={t("sourceDrawer.activeVersion")}
          value={data.evidence.publication.version ?? t("common.unknown")}
        />
      </Section>

      <Section title={t("sourceDrawer.coverage")}>
        <Detail
          label={t("sourceDrawer.presence")}
          value={<CoverageStatus status={source.presence} />}
        />
        <Detail
          label={t("sourceDrawer.regionRelation")}
          value={
            <CoverageStatus
              status={source.region.relation}
              label={t(`relation.${source.region.relation}`)}
            />
          }
        />
        <Detail label={t("sourceDrawer.regionBasis")} value={t(`basis.${source.region.basis}`)} />
        <Detail
          label={t("sourceDrawer.regions")}
          value={
            source.region.keys.length > 0
              ? source.region.keys.join(", ")
              : t("sources.regionUnknown")
          }
        />
        {source.region.bounds && (
          <Detail label={t("sourceDrawer.bounds")} value={source.region.bounds.join(", ")} />
        )}
        {data.evidence.count && (
          <Detail
            label={t("sourceDrawer.count")}
            value={`${data.evidence.count.value.toLocaleString()} ${data.evidence.count.unit} (${data.evidence.count.scope})`}
          />
        )}
      </Section>

      <Section title={t("sourceDrawer.timeline")}>
        <Detail
          label={t("sourceDrawer.freshness")}
          value={
            <CoverageStatus status={data.evidence.freshness} reasons={data.evidence.reasons} />
          }
        />
        <Detail
          label={t("sourceDrawer.lastAttempt")}
          value={`${formatCoverageDate(source.lastAttemptAt)} · ${t(`attempt.${source.latestAttempt.outcome}`)}`}
        />
        <Detail
          label={t("sourceDrawer.lastCheck")}
          value={formatCoverageDate(source.lastSuccessfulCheckAt)}
        />
        <Detail
          label={t("sourceDrawer.lastPublished")}
          value={formatCoverageDate(source.lastPublishedAt)}
        />
        <Detail
          label={t("sourceDrawer.upstreamAsOf")}
          value={formatCoverageDate(source.upstreamAsOf)}
        />
        <Detail label={t("sourceDrawer.expiresAt")} value={formatCoverageDate(source.expiresAt)} />
        <Detail
          label={t("sourceDrawer.policy")}
          value={`${data.evidence.policy.basis} · ${data.evidence.policy.provenance}`}
        />
      </Section>

      {data.runtime && (
        <Section title={t("capabilities.runtime")}>
          <Detail
            label={t("sources.state")}
            value={<CoverageStatus status={data.runtime.status} />}
          />
          <Detail
            label={t("sourceDrawer.lastCheck")}
            value={formatCoverageDate(data.runtime.observedAt)}
          />
          <Detail
            label={t("sourceDrawer.expiresAt")}
            value={formatCoverageDate(data.runtime.validUntil)}
          />
        </Section>
      )}
      <Section title={t("sourceDrawer.failures")}>
        <Detail
          label={t("sourceDrawer.latestOutcome")}
          value={<CoverageStatus status={source.latestAttempt.outcome} />}
        />
        <Detail
          label={t("sourceDrawer.message")}
          value={source.latestAttempt.message ?? t("common.none")}
        />
        {source.latestAttempt.job && (
          <Detail
            label={t("sourceDrawer.job")}
            value={`${source.latestAttempt.job.system}: ${source.latestAttempt.job.id}`}
          />
        )}
        <List dense disablePadding>
          {data.recentAttempts.map((attempt) => (
            <ListItem key={`${attempt.key}:${attempt.at ?? "none"}`} disableGutters>
              <ListItemText
                primary={`${formatCoverageDate(attempt.at)} · ${t(`attempt.${attempt.outcome}`)}`}
                secondary={attempt.message ?? undefined}
              />
            </ListItem>
          ))}
        </List>
      </Section>

      <Section title={t("sourceDrawer.rights")}>
        <Detail
          label={t(`assessment.${assessment}`)}
          value={
            source.rights.status === "not-applicable"
              ? t("common.notApplicable")
              : t(`rightsStatus.${source.rights.status}`)
          }
        />
        {data.rights.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t("rights.missing")}
          </Typography>
        )}
        {data.rights.map((right) => (
          <Stack
            key={right.key}
            spacing={0.5}
            sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 650 }}>
              {right.name ?? right.sourceId}
            </Typography>
            <Detail label={t("rights.commercial")} value={t(`permission.${right.commercialUse}`)} />
            <Detail
              label={t("rights.sourceData")}
              value={t(`permission.${right.redistribution.sourceData}`)}
            />
            <Detail
              label={t("rights.derivedData")}
              value={t(`permission.${right.redistribution.derivedData}`)}
            />
            {right.license && <Detail label={t("rights.license")} value={right.license} />}
            {right.attribution && (
              <Detail label={t("rights.attribution")} value={right.attribution} />
            )}
            <Detail
              label={t("rights.conditions")}
              value={
                right.usageConditions.length > 0
                  ? right.usageConditions.join(" · ")
                  : t("common.none")
              }
            />
            <Detail
              label={t("rights.reviewedAt")}
              value={right.reviewedAt ? formatCoverageDate(right.reviewedAt) : t("common.unknown")}
            />
            <Detail
              label={t("rights.origin")}
              value={right.evidenceOrigin ?? t("common.unknown")}
            />
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              {right.licenseUrl && (
                <Link href={safeHref(right.licenseUrl)} target="_blank" rel="noreferrer">
                  {t("rights.license")}
                </Link>
              )}
              {right.termsUrl && (
                <Link href={safeHref(right.termsUrl)} target="_blank" rel="noreferrer">
                  {t("rights.terms")}
                </Link>
              )}
            </Stack>
          </Stack>
        ))}
      </Section>

      {source.correctiveLinks.length > 0 && (
        <Section title={t("sourceDrawer.actions")}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
            {source.correctiveLinks.map((link) => (
              <Link key={link.href} href={safeHref(link.href)}>
                {link.label}
              </Link>
            ))}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack component="section" spacing={0.75}>
      <Typography component="h3" variant="subtitle2">
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 125, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography component="div" variant="body2" sx={{ overflowWrap: "anywhere" }}>
        {value}
      </Typography>
    </Stack>
  );
}

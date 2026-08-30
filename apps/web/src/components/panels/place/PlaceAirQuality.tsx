"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type {
  AirQualityCurrentResponse,
  AirQualityEvidence,
  AirQualityForecastResponse,
  AirQualityIndex,
  AirQualityStandardId,
} from "@openmapx/core";
import { safeHref, useAirQuality, useAirQualityForecast } from "@openmapx/core";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { SectionAttribution } from "@/components/ui/SectionAttribution";
import {
  categoryPresentation,
  dominantPollutantKeys,
  freshnessPresentation,
  missingRequirementPresentation,
  pollutantPresentation,
  programLabelKey,
  provenancePresentation,
  qualityPresentation,
  standardLabelKey,
  unitDisplay,
  warningLabelKey,
} from "./airQualityPresentation";

interface Props {
  lat: number;
  lng: number;
  enabled?: boolean;
  countryCode?: string;
  subdivisionCode?: string;
}

const COMPARISON_STANDARDS: readonly AirQualityStandardId[] = [
  "us-epa-2024",
  "eu-eea-current",
  "uk-daqi-current",
  "in-naqi-current",
  "cn-hj633-2026",
  "ca-aqhi-current",
];

function findIndex(
  response: AirQualityCurrentResponse,
  indexId: string | null,
): { evidence: AirQualityEvidence; index: AirQualityIndex } | null {
  if (!indexId) return null;
  for (const evidence of response.evidence) {
    const index = evidence.indices.find((candidate) => candidate.indexId === indexId);
    if (index) return { evidence, index };
  }
  return null;
}

function basisLabelKey(basis: AirQualityEvidence["basis"]): string {
  switch (basis) {
    case "ground":
      return "airQuality.basis.ground";
    case "model":
      return "airQuality.basis.model";
    case "hybrid":
      return "airQuality.basis.hybrid";
  }
}

function spatialLabelKey(kind: AirQualityEvidence["spatial"]["kind"]): string {
  switch (kind) {
    case "station":
      return "airQuality.spatial.station";
    case "reporting-area":
      return "airQuality.spatial.reportingArea";
    case "community":
      return "airQuality.spatial.community";
    case "grid-cell":
      return "airQuality.spatial.gridCell";
  }
}

function stationClassLabelKey(
  stationClass: AirQualityEvidence["spatial"]["stationClass"],
): string | null {
  switch (stationClass) {
    case "reference":
      return "airQuality.stationClass.reference";
    case "regulatory":
      return "airQuality.stationClass.regulatory";
    case "indicative":
      return "airQuality.stationClass.indicative";
    case "low-cost":
      return "airQuality.stationClass.lowCost";
    case "unknown":
      return "airQuality.stationClass.unknown";
    case null:
      return null;
  }
}

function EvidenceSources({ evidence }: { evidence: AirQualityEvidence }) {
  const t = useTranslations();
  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary">
        {t("airQuality.provider")}: {evidence.providerId}
      </Typography>
      {evidence.sources.map((source) => {
        const sourceUrl = source.url ? safeHref(source.url) : undefined;
        const licenseUrl = source.license?.url ? safeHref(source.license.url) : undefined;
        const methodologyUrl = source.methodologyUrl ? safeHref(source.methodologyUrl) : undefined;
        return (
          <Box key={source.sourceId}>
            {source.owner && (
              <Typography variant="caption" component="div" color="text.secondary">
                {t("airQuality.owner")}: {source.owner}
              </Typography>
            )}
            <SectionAttribution
              name={source.name}
              url={sourceUrl}
              license={source.license?.name}
              licenseUrl={licenseUrl}
              attribution={source.attribution ?? undefined}
            />
            {methodologyUrl && (
              <Link
                href={safeHref(methodologyUrl)}
                target="_blank"
                rel="noopener noreferrer"
                variant="caption"
              >
                {t("airQuality.methodology")}
              </Link>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

function EvidenceContext({ evidence }: { evidence: AirQualityEvidence }) {
  const t = useTranslations();
  const format = useFormatter();
  const index = evidence.indices[0] ?? null;
  const timestamp = evidence.forecastFor ?? evidence.observedAt ?? evidence.publishedAt;
  const classKey = stationClassLabelKey(evidence.spatial.stationClass);
  const estimated = evidence.pollutants.some((pollutant) => pollutant.estimated);
  const gapFilled = evidence.pollutants.some((pollutant) => pollutant.gapFilled);
  const completeness = evidence.pollutants
    .map(({ completenessPercent }) => completenessPercent)
    .filter((value): value is number => value !== null);
  return (
    <Stack spacing={0.35} sx={{ mt: 0.75 }}>
      <Typography variant="caption" color="text.secondary">
        {t(spatialLabelKey(evidence.spatial.kind))}
        {evidence.spatial.name ? ` · ${evidence.spatial.name}` : ""}
        {evidence.spatial.distanceMeters !== null
          ? ` · ${Math.round(evidence.spatial.distanceMeters)} ${t("airQuality.metersAway")}`
          : ""}
        {classKey ? ` · ${t(classKey)}` : ""}
      </Typography>
      {timestamp && (
        <Typography variant="caption" color="text.secondary">
          {evidence.forecastFor ? t("airQuality.forecastFor") : t("airQuality.observedAt")}:{" "}
          {format.dateTime(new Date(timestamp), { dateStyle: "medium", timeStyle: "short" })}
        </Typography>
      )}
      {evidence.validUntil && (
        <Typography variant="caption" color="text.secondary">
          {t("airQuality.validUntil")}:{" "}
          {format.dateTime(new Date(evidence.validUntil), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Typography>
      )}
      {index && index.dominantPollutants.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {t("airQuality.dominantPollutants")}:{" "}
          {dominantPollutantKeys(index.dominantPollutants)
            .map((key) => t(key))
            .join(", ")}
        </Typography>
      )}
      <Stack direction="row" useFlexGap sx={{ gap: 0.75, flexWrap: "wrap" }}>
        {estimated && <Chip size="small" label={t("airQuality.flag.estimated")} />}
        {gapFilled && <Chip size="small" label={t("airQuality.flag.gapFilled")} />}
        {completeness.length > 0 && (
          <Chip
            size="small"
            label={`${t("airQuality.completeness")}: ${Math.min(...completeness)}%`}
          />
        )}
        {evidence.spatial.mobile === true && (
          <Chip size="small" label={t("airQuality.flag.mobile")} />
        )}
      </Stack>
    </Stack>
  );
}

function EvidenceCard({ evidence }: { evidence: AirQualityEvidence }) {
  const t = useTranslations();
  const firstIndex = evidence.indices[0] ?? null;
  const provenance = provenancePresentation({
    basis: evidence.basis,
    derivation: firstIndex?.derivation ?? null,
    authority: firstIndex?.authority ?? null,
  });
  return (
    <Box
      data-testid={`air-quality-evidence-${evidence.basis}`}
      sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.25 }}
    >
      <Typography component="h4" variant="subtitle2">
        {t(basisLabelKey(evidence.basis))}
      </Typography>
      <Typography variant="body2">{t(provenance.labelKey)}</Typography>
      <Typography variant="caption" color="text.secondary">
        {t(qualityPresentation(evidence.qualityStatus).labelKey)} ·{" "}
        {t(freshnessPresentation(evidence.freshness).labelKey)}
      </Typography>
      <Stack spacing={0.3} sx={{ mt: 0.75 }}>
        {evidence.pollutants.map((pollutant) => (
          <Typography key={`${pollutant.pollutant}:${pollutant.intervalEnd}`} variant="body2">
            {pollutantPresentation(pollutant.pollutant).symbol}: {pollutant.value}{" "}
            {unitDisplay(pollutant.unit)}
          </Typography>
        ))}
      </Stack>
      <EvidenceContext evidence={evidence} />
      <EvidenceSources evidence={evidence} />
    </Box>
  );
}

function Headline({ response }: { response: AirQualityCurrentResponse }) {
  const t = useTranslations();
  const selected = findIndex(response, response.primaryIndexId);
  const primaryEvidence = response.evidence.find(
    ({ observationId }) => observationId === response.primaryEvidenceId,
  );
  if (!primaryEvidence) return null;
  if (!selected) {
    const raw = primaryEvidence.pollutants[0];
    return (
      <Box>
        <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
          {t("airQuality.currentHeading")}
        </Typography>
        {raw && (
          <Typography variant="h5" component="p" sx={{ my: 0.5 }}>
            {pollutantPresentation(raw.pollutant).symbol}: {raw.value} {unitDisplay(raw.unit)}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          {t("airQuality.noQualifyingLocalIndex")}
        </Typography>
        <Typography variant="body2">
          {t(
            provenancePresentation({
              basis: primaryEvidence.basis,
              derivation: null,
              authority: null,
            }).labelKey,
          )}
        </Typography>
        <EvidenceContext evidence={primaryEvidence} />
      </Box>
    );
  }
  const category = categoryPresentation(selected.index.standardId, selected.index.categoryId);
  const provenance = provenancePresentation({
    basis: selected.evidence.basis,
    derivation: selected.index.derivation,
    authority: selected.index.authority,
  });
  return (
    <Box>
      <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 700 }}>
        {t("airQuality.currentHeading")}
      </Typography>
      <Stack
        direction="row"
        useFlexGap
        sx={{ my: 0.5, alignItems: "center", gap: 1, flexWrap: "wrap" }}
      >
        <Chip
          label={t(category.labelKey)}
          sx={{
            bgcolor: category.swatch,
            color: category.foreground,
            border: "2px solid",
            borderColor: category.foreground,
            fontWeight: 700,
          }}
        />
        <Typography variant="h5" component="p" sx={{ m: 0 }}>
          {selected.index.displayValue}
        </Typography>
      </Stack>
      <Typography variant="body2">
        {t(programLabelKey(response.jurisdiction.programId))} ·{" "}
        {t(standardLabelKey(selected.index.standardId))}
      </Typography>
      <Typography variant="body2">{t(provenance.labelKey)}</Typography>
      <Typography variant="caption" color="text.secondary">
        {t(qualityPresentation(selected.index.qualityStatus).labelKey)} ·{" "}
        {t(freshnessPresentation(selected.evidence.freshness).labelKey)}
      </Typography>
      <EvidenceContext evidence={selected.evidence} />
    </Box>
  );
}

function Comparison({ response }: { response: AirQualityCurrentResponse }) {
  const t = useTranslations();
  if (!response.comparisonStandardId) return null;
  const indices = response.comparisonIndexIds.flatMap((indexId) => {
    const found = findIndex(response, indexId);
    return found ? [found.index] : [];
  });
  const missing = [
    ...new Set(
      response.selection.rejected.flatMap(({ missingRequirements }) => missingRequirements),
    ),
  ];
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography component="h4" variant="subtitle2">
        {t("airQuality.comparison.heading")}
      </Typography>
      {indices.length > 0 ? (
        indices.map((index) => (
          <Typography key={index.indexId} variant="body2">
            {t(standardLabelKey(index.standardId))}: {index.displayValue} ·{" "}
            {t(categoryPresentation(index.standardId, index.categoryId).labelKey)}
          </Typography>
        ))
      ) : (
        <>
          <Typography variant="body2">{t("airQuality.comparison.unavailable")}</Typography>
          {missing.map((requirement) => (
            <Typography key={requirement} variant="caption" component="div" color="text.secondary">
              {t(missingRequirementPresentation(requirement).labelKey)}
            </Typography>
          ))}
        </>
      )}
    </Box>
  );
}

function ForecastContent({ response }: { response: AirQualityForecastResponse }) {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <Stack spacing={1.25} sx={{ mt: 1 }}>
      <Box data-testid="air-quality-forecast-frames">
        <Typography component="h4" variant="subtitle2">
          {t("airQuality.forecast.frames")}
        </Typography>
        <Stack direction="row" useFlexGap sx={{ gap: 0.75, flexWrap: "wrap" }}>
          {response.frames.map((frame) => (
            <Box key={frame.frameAt} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography variant="caption">
                {format.dateTime(new Date(frame.frameAt), { timeStyle: "short" })}
              </Typography>
              <Chip
                size="small"
                variant="outlined"
                label={t(
                  frame.status === "ok"
                    ? "airQuality.frame.ok"
                    : frame.status === "partial"
                      ? "airQuality.frame.partial"
                      : "airQuality.frame.unavailable",
                )}
              />
            </Box>
          ))}
        </Stack>
      </Box>
      {response.series.map((series) => {
        const items = series.evidenceIds.flatMap((evidenceId) => {
          const item = response.evidence.find(({ observationId }) => observationId === evidenceId);
          return item ? [item] : [];
        });
        return (
          <Box
            key={series.seriesId}
            data-testid={`air-quality-forecast-${series.seriesId}`}
            sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.25 }}
          >
            <Typography component="h4" variant="subtitle2">
              {t(basisLabelKey(series.basis))}
            </Typography>
            {items.map((item) => {
              const itemIndex = item.indices[0] ?? null;
              const raw = item.pollutants[0] ?? null;
              return (
                <Box key={item.observationId} sx={{ mt: 0.75 }}>
                  <Typography variant="body2">
                    {item.forecastFor
                      ? format.dateTime(new Date(item.forecastFor), {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : t("airQuality.timeUnknown")}
                    {" · "}
                    {itemIndex
                      ? `${itemIndex.displayValue} · ${t(
                          categoryPresentation(itemIndex.standardId, itemIndex.categoryId).labelKey,
                        )}`
                      : raw
                        ? `${pollutantPresentation(raw.pollutant).symbol}: ${raw.value} ${unitDisplay(raw.unit)}`
                        : t("airQuality.unavailable")}
                  </Typography>
                  <Typography variant="caption" component="div" color="text.secondary">
                    {t(
                      provenancePresentation({
                        basis: item.basis,
                        derivation: itemIndex?.derivation ?? null,
                        authority: itemIndex?.authority ?? null,
                      }).labelKey,
                    )}
                    {" · "}
                    {t(qualityPresentation(item.qualityStatus).labelKey)}
                    {" · "}
                    {t(freshnessPresentation(item.freshness).labelKey)}
                  </Typography>
                  {!itemIndex && (
                    <Typography variant="caption" color="text.secondary">
                      {t("airQuality.noQualifyingLocalIndex")}
                    </Typography>
                  )}
                </Box>
              );
            })}
            {items[0] && <EvidenceSources evidence={items[0]} />}
          </Box>
        );
      })}
    </Stack>
  );
}

export function PlaceAirQuality({ lat, lng, enabled = true, countryCode, subdivisionCode }: Props) {
  const t = useTranslations();
  const [comparisonStandard, setComparisonStandard] = useState<AirQualityStandardId | undefined>();
  const [forecastOpen, setForecastOpen] = useState(false);
  const current = useAirQuality(lat, lng, {
    enabled,
    countryCode,
    subdivisionCode,
    comparisonStandard,
  });
  const forecast = useAirQualityForecast(lat, lng, {
    enabled: enabled && forecastOpen,
    hours: 48,
    countryCode,
    subdivisionCode,
    comparisonStandard,
  });

  if (current.isLoading) {
    return (
      <Box role="status" aria-label={t("airQuality.loading")} sx={{ py: 1 }}>
        <Typography
          sx={{
            position: "absolute",
            width: 1,
            height: 1,
            p: 0,
            m: -1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {t("airQuality.loading")}
        </Typography>
        <Skeleton variant="text" width="65%" />
        <Skeleton variant="text" width="45%" />
      </Box>
    );
  }
  if (current.isError) return <Alert severity="error">{t("airQuality.requestError")}</Alert>;
  const response = current.data;
  if (!response || response.status === "unavailable" || !response.primaryEvidenceId) {
    return (
      <Typography role="status" variant="body2" color="text.secondary" sx={{ py: 1 }}>
        {t("airQuality.unavailable")}
      </Typography>
    );
  }

  return (
    <Box sx={{ py: 1 }}>
      <Headline response={response} />
      {response.meta.warnings.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {response.meta.warnings.map((warning) => (
            <Typography key={warning} variant="body2">
              {t(warningLabelKey(warning))}
            </Typography>
          ))}
        </Alert>
      )}
      <Box component="label" sx={{ display: "block", mt: 1.5 }}>
        <Typography variant="caption" component="span" sx={{ display: "block", mb: 0.5 }}>
          {t("airQuality.comparison.label")}
        </Typography>
        <Box
          component="select"
          aria-label={t("airQuality.comparison.label")}
          value={comparisonStandard ?? ""}
          onChange={(event) =>
            setComparisonStandard(
              event.target.value === "" ? undefined : (event.target.value as AirQualityStandardId),
            )
          }
          sx={{
            width: "100%",
            minHeight: 40,
            borderRadius: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
            color: "text.primary",
            px: 1,
          }}
        >
          <option value="">{t("airQuality.comparison.auto")}</option>
          {COMPARISON_STANDARDS.map((standard) => (
            <option key={standard} value={standard}>
              {t(standardLabelKey(standard))}
            </option>
          ))}
        </Box>
      </Box>
      <Comparison response={response} />
      <Divider sx={{ my: 1.5 }} />
      <Typography component="h3" variant="subtitle2" sx={{ mb: 1 }}>
        {t("airQuality.evidence.heading")}
      </Typography>
      <Stack spacing={1}>
        {response.evidence.map((item) => (
          <EvidenceCard key={item.observationId} evidence={item} />
        ))}
      </Stack>
      <Button
        type="button"
        variant="text"
        endIcon={
          <ExpandMoreIcon
            sx={{ transform: forecastOpen ? "rotate(180deg)" : "none" }}
            aria-hidden="true"
          />
        }
        aria-expanded={forecastOpen}
        onClick={() => setForecastOpen((open) => !open)}
        sx={{ mt: 1.5, px: 0, "@media (prefers-reduced-motion: reduce)": { transition: "none" } }}
      >
        {t(forecastOpen ? "airQuality.forecast.hide" : "airQuality.forecast.show")}
      </Button>
      {forecastOpen && (
        <Box>
          {forecast.isLoading && (
            <Typography role="status">{t("airQuality.forecast.loading")}</Typography>
          )}
          {forecast.isError && <Alert severity="error">{t("airQuality.forecast.error")}</Alert>}
          {forecast.data && <ForecastContent response={forecast.data} />}
        </Box>
      )}
      <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1.5 }}>
        {t("airQuality.informationalOnly")}
      </Typography>
    </Box>
  );
}

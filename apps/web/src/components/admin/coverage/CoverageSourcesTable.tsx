"use client";

import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { CoverageReport, CoverageSourceRow } from "@openmapx/core/coverage";
import { useTranslations } from "next-intl";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { CoverageStatus, formatCoverageDate } from "./CoverageStatus";

export function CoverageSourcesTable({
  report,
  onSelect,
  onPageChange,
  onRowsPerPageChange,
}: {
  report: CoverageReport;
  onSelect: (source: CoverageSourceRow) => void;
  onPageChange: (offset: number) => void;
  onRowsPerPageChange: (limit: number) => void;
}) {
  const t = useTranslations("adminCoverage");
  const pagination = report.sourcePagination;
  const page = Math.floor(pagination.offset / pagination.limit);

  return (
    <AdminTableSurface
      title={t("sources.title")}
      description={t("sources.description", { count: report.totalSourceCount })}
      pagination={
        <AdminTablePagination
          count={pagination.total}
          page={page}
          rowsPerPage={pagination.limit}
          rowsPerPageOptions={[25, 50, 100]}
          onPageChange={(_event, nextPage) => onPageChange(nextPage * pagination.limit)}
          onRowsPerPageChange={(event) => onRowsPerPageChange(Number(event.target.value))}
        />
      }
    >
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" aria-label={t("sources.ariaLabel")} sx={{ minWidth: 980 }}>
          <TableHead>
            <TableRow>
              <TableCell>{t("sources.source")}</TableCell>
              <TableCell>{t("sources.stream")}</TableCell>
              <TableCell>{t("sources.state")}</TableCell>
              <TableCell>{t("sources.region")}</TableCell>
              <TableCell>{t("sources.lastCheck")}</TableCell>
              <TableCell>{t("sources.published")}</TableCell>
              <TableCell>{t("sources.expiry")}</TableCell>
              <TableCell>{t("sources.rights")}</TableCell>
              <TableCell>{t("sources.attention")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.sources.map((source) => (
              <SourceRow key={source.key} source={source} onSelect={onSelect} />
            ))}
            {report.sources.length === 0 && (
              <TableRow>
                <TableCell colSpan={9}>
                  <Typography color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
                    {t("sources.empty")}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </AdminTableSurface>
  );
}

function SourceRow({
  source,
  onSelect,
}: {
  source: CoverageSourceRow;
  onSelect: (source: CoverageSourceRow) => void;
}) {
  const t = useTranslations("adminCoverage");
  const reasons = source.reasons;
  return (
    <TableRow sx={{ "&:last-child td": { borderBottom: 0 } }}>
      <TableCell component="th" scope="row">
        <Button
          variant="text"
          size="small"
          onClick={() => onSelect(source)}
          aria-label={t("sources.open", { source: source.name })}
          endIcon={<OpenInNewIcon fontSize="small" />}
          sx={{ justifyContent: "flex-start", textAlign: "left", px: 0.5 }}
        >
          <Box sx={{ minWidth: 0, textAlign: "left" }}>
            <Typography component="span" variant="body2" sx={{ display: "block", fontWeight: 650 }}>
              {source.name}
            </Typography>
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ display: "block" }}
            >
              {source.owner.id} · {source.sourceId}
            </Typography>
          </Box>
        </Button>
      </TableCell>
      <TableCell>
        <Typography variant="body2">{source.stream}</Typography>
        <Typography variant="caption" color="text.secondary">
          {t(`domain.${source.domain}`)}
        </Typography>
      </TableCell>
      <TableCell>
        <Stack sx={{ gap: 0.5 }}>
          <CoverageStatus status={source.presence} />
          <CoverageStatus status={source.freshness} />
          <Typography variant="caption" color="text.secondary">
            {source.active === true
              ? t("sources.active")
              : source.active === false
                ? t("sources.inactive")
                : t("sources.activeUnknown")}
          </Typography>
        </Stack>
      </TableCell>
      <TableCell>
        <CoverageStatus
          status={source.region.relation}
          label={t(`relation.${source.region.relation}`)}
        />
        <Typography variant="caption" color="text.secondary" component="div">
          {source.region.keys.length > 0
            ? source.region.keys.join(", ")
            : t("sources.regionUnknown")}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="body2" title={source.lastSuccessfulCheckAt ?? undefined}>
          {formatCoverageDate(source.lastSuccessfulCheckAt)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t(`attempt.${source.latestAttempt.outcome}`)}
        </Typography>
      </TableCell>
      <TableCell>{formatCoverageDate(source.lastPublishedAt)}</TableCell>
      <TableCell>{formatCoverageDate(source.expiresAt)}</TableCell>
      <TableCell>
        <CoverageStatus status={source.rights.status} />
      </TableCell>
      <TableCell>
        {reasons.length > 0 ? (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ maxWidth: 180, display: "block" }}
          >
            {reasons
              .slice(0, 3)
              .map((reason) => t(`reason.${reason}`))
              .join(" · ")}
            {reasons.length > 3 ? ` (+${reasons.length - 3})` : ""}
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            —
          </Typography>
        )}
      </TableCell>
    </TableRow>
  );
}

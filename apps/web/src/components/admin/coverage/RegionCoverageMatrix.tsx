"use client";

import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { CoverageDomain, CoverageRegionsResponse } from "@openmapx/core/coverage";
import { useTranslations } from "next-intl";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { CoverageStatus } from "./CoverageStatus";

export const COVERAGE_MATRIX_DOMAINS: readonly CoverageDomain[] = [
  "addresses",
  "pois",
  "transit",
  "ev",
  "parking",
  "traffic",
];

export function RegionCoverageMatrix({
  data,
  selectedRegionId,
  onSelect,
  onPageChange,
}: {
  data: CoverageRegionsResponse;
  selectedRegionId?: string;
  onSelect: (regionId: string, domain?: CoverageDomain) => void;
  onPageChange?: (offset: number) => void;
}) {
  const t = useTranslations("adminCoverage");

  return (
    <Paper component="section" variant="outlined" aria-labelledby="coverage-matrix-heading">
      <Stack sx={{ px: 1.5, py: 1.25, gap: 0.25 }}>
        <Typography id="coverage-matrix-heading" component="h2" variant="subtitle1">
          {t("matrix.title")}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("matrix.description")}
        </Typography>
      </Stack>
      <TableContainer sx={{ display: { xs: "none", sm: "block" }, overflowX: "auto" }}>
        <Table size="small" aria-label={t("matrix.ariaLabel")} sx={{ minWidth: 780 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ minWidth: 180 }}>{t("matrix.region")}</TableCell>
              {COVERAGE_MATRIX_DOMAINS.map((domain) => (
                <TableCell key={domain} align="center" sx={{ minWidth: 100 }}>
                  {t(`domain.${domain}`)}
                </TableCell>
              ))}
              <TableCell align="right">{t("matrix.sources")}</TableCell>
              <TableCell align="right">{t("matrix.attention")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.regions.map((row) => {
              const selected = row.region.key === selectedRegionId;
              return (
                <TableRow
                  key={row.region.key}
                  selected={selected}
                  sx={{ "&:last-child td": { borderBottom: 0 } }}
                >
                  <TableCell component="th" scope="row">
                    <ButtonBase
                      component="button"
                      onClick={() => onSelect(row.region.key)}
                      aria-label={t("matrix.selectRegion", { region: row.region.label })}
                      sx={{
                        display: "flex",
                        width: "100%",
                        justifyContent: "flex-start",
                        textAlign: "left",
                        borderRadius: 1,
                        p: 0.5,
                        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 650 }} noWrap>
                          {row.region.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {row.region.key}
                        </Typography>
                      </Box>
                      <ArrowForwardIcon sx={{ ml: "auto", fontSize: 16, color: "text.disabled" }} />
                    </ButtonBase>
                  </TableCell>
                  {COVERAGE_MATRIX_DOMAINS.map((domain) => {
                    const summary = row.domains[domain];
                    return (
                      <TableCell key={domain} align="center" sx={{ p: 0.75 }}>
                        <ButtonBase
                          component="button"
                          onClick={() => onSelect(row.region.key, domain)}
                          aria-label={t("matrix.selectDomain", {
                            region: row.region.label,
                            domain: t(`domain.${domain}`),
                            status: t(`status.${summary.status}`),
                          })}
                          sx={{
                            display: "inline-flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 0.25,
                            borderRadius: 1,
                            p: 0.5,
                            "&:focus-visible": {
                              outline: "2px solid",
                              outlineColor: "primary.main",
                            },
                          }}
                        >
                          <CoverageStatus status={summary.status} />
                          <Typography variant="caption" color="text.secondary">
                            {t("matrix.operationCount", {
                              count: summary.operational,
                              total:
                                summary.operational +
                                summary.limited +
                                summary.unavailable +
                                summary.unknown,
                            })}
                          </Typography>
                        </ButtonBase>
                      </TableCell>
                    );
                  })}
                  <TableCell align="right">{row.sourceCount}</TableCell>
                  <TableCell align="right">
                    <Typography
                      component="span"
                      variant="body2"
                      color={row.attentionCount > 0 ? "warning.main" : "text.secondary"}
                      aria-label={t("matrix.attentionCount", { count: row.attentionCount })}
                    >
                      {row.attentionCount}
                    </Typography>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Stack sx={{ display: { xs: "flex", sm: "none" }, gap: 1, p: 1.5 }}>
        {data.regions.map((row) => {
          const selected = row.region.key === selectedRegionId;
          return (
            <Paper
              key={row.region.key}
              component="article"
              variant="outlined"
              sx={{ p: 1, borderColor: selected ? "primary.main" : "divider" }}
            >
              <ButtonBase
                component="button"
                onClick={() => onSelect(row.region.key)}
                aria-label={t("matrix.selectRegion", { region: row.region.label })}
                sx={{
                  display: "flex",
                  width: "100%",
                  justifyContent: "flex-start",
                  textAlign: "left",
                  borderRadius: 1,
                  p: 0.5,
                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 650 }} noWrap>
                    {row.region.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {row.region.key}
                  </Typography>
                </Box>
                <ArrowForwardIcon sx={{ ml: "auto", fontSize: 16, color: "text.disabled" }} />
              </ButtonBase>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 0.5,
                  mt: 0.75,
                }}
              >
                {COVERAGE_MATRIX_DOMAINS.map((domain) => {
                  const summary = row.domains[domain];
                  return (
                    <ButtonBase
                      key={domain}
                      component="button"
                      onClick={() => onSelect(row.region.key, domain)}
                      aria-label={t("matrix.selectDomain", {
                        region: row.region.label,
                        domain: t(`domain.${domain}`),
                        status: t(`status.${summary.status}`),
                      })}
                      sx={{
                        display: "flex",
                        justifyContent: "flex-start",
                        gap: 0.75,
                        borderRadius: 1,
                        p: 0.75,
                        textAlign: "left",
                        "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                      }}
                    >
                      <CoverageStatus status={summary.status} />
                      <Stack sx={{ minWidth: 0 }}>
                        <Typography variant="caption" sx={{ fontWeight: 650 }} noWrap>
                          {t(`domain.${domain}`)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {t("matrix.operationCount", {
                            count: summary.operational,
                            total:
                              summary.operational +
                              summary.limited +
                              summary.unavailable +
                              summary.unknown,
                          })}
                        </Typography>
                      </Stack>
                    </ButtonBase>
                  );
                })}
              </Box>
              <Stack direction="row" spacing={2} sx={{ mt: 0.75, px: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {t("matrix.sources")}: {row.sourceCount}
                </Typography>
                <Typography
                  variant="caption"
                  color={row.attentionCount > 0 ? "warning.main" : "text.secondary"}
                >
                  {t("matrix.attention")}: {row.attentionCount}
                </Typography>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
      {onPageChange && data.total > data.pagination.limit && (
        <AdminTablePagination
          count={data.total}
          page={Math.floor(data.pagination.offset / data.pagination.limit)}
          rowsPerPage={data.pagination.limit}
          rowsPerPageOptions={[data.pagination.limit]}
          onPageChange={(_event, page) => onPageChange(page * data.pagination.limit)}
          onRowsPerPageChange={() => undefined}
        />
      )}
      {data.unassignedSourceCount > 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", px: 1.5, py: 1 }}
        >
          {t("matrix.unassigned", { count: data.unassignedSourceCount })}
        </Typography>
      )}
    </Paper>
  );
}

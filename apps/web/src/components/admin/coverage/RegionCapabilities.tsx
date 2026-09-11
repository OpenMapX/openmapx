"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { CoverageDomain, CoverageReport } from "@openmapx/core/coverage";
import { useTranslations } from "next-intl";
import { CoverageStatus } from "./CoverageStatus";

export function RegionCapabilities({
  report,
  domain,
}: {
  report: CoverageReport;
  domain?: CoverageDomain;
}) {
  const t = useTranslations("adminCoverage");
  const capabilities = report.capabilities.filter(
    (capability) => !domain || capability.domain === domain,
  );

  return (
    <Paper component="section" variant="outlined" aria-labelledby="coverage-capabilities-heading">
      <Stack sx={{ px: 1.5, py: 1.25, gap: 0.25 }}>
        <Typography id="coverage-capabilities-heading" component="h2" variant="subtitle1">
          {t("capabilities.title")}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("capabilities.description")}
        </Typography>
      </Stack>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" aria-label={t("capabilities.ariaLabel")} sx={{ minWidth: 850 }}>
          <TableHead>
            <TableRow>
              <TableCell>{t("capabilities.operation")}</TableCell>
              <TableCell>{t("capabilities.status")}</TableCell>
              <TableCell>{t("capabilities.provider")}</TableCell>
              <TableCell>{t("capabilities.region")}</TableCell>
              <TableCell>{t("capabilities.runtime")}</TableCell>
              <TableCell>{t("sourceDrawer.rights")}</TableCell>
              <TableCell>{t("capabilities.evidence")}</TableCell>
              <TableCell>{t("capabilities.reasons")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {capabilities.map((capability) => {
              const candidate = [...capability.candidates].sort((a, b) => {
                const rank = { operational: 4, limited: 3, unknown: 2, unavailable: 1 };
                return rank[b.status] - rank[a.status];
              })[0];
              const operation = report.operations.find(
                (item) => item.operationId === capability.operationId,
              );
              const reasons = [...new Set([...capability.reasons, ...capability.optionalReasons])];
              return (
                <TableRow
                  key={capability.operationId}
                  sx={{ "&:last-child td": { borderBottom: 0 } }}
                >
                  <TableCell component="th" scope="row">
                    <Typography variant="body2" sx={{ fontWeight: 650 }}>
                      {t(`operation.${capability.operationId.replaceAll(".", "_")}`)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {capability.operationId}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <CoverageStatus status={capability.status} reasons={reasons} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {candidate?.label ?? t("capabilities.noProvider")}
                    </Typography>
                    {candidate && candidate.providerId !== "none" && (
                      <Typography variant="caption" color="text.secondary">
                        {candidate.providerId}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <CoverageStatus
                      status={capability.geographicQualification}
                      label={t(`relation.${capability.geographicQualification}`)}
                    />
                  </TableCell>
                  <TableCell>
                    <CoverageStatus status={capability.runtime} />
                  </TableCell>
                  <TableCell>
                    <CoverageStatus status={operation?.rights.status ?? "review-required"} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap", maxWidth: 250 }}>
                      {capability.evidenceKeys.length > 0 ? (
                        capability.evidenceKeys.map((key) => (
                          <Chip
                            key={key}
                            label={key}
                            size="small"
                            variant="outlined"
                            sx={{ maxWidth: 230 }}
                          />
                        ))
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {t("common.notAvailable")}
                        </Typography>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ maxWidth: 260 }}>
                      {reasons.length > 0 ? (
                        reasons.map((reason) => (
                          <Typography
                            key={reason}
                            variant="caption"
                            component="div"
                            color="text.secondary"
                          >
                            {t(`reason.${reason}`)}
                          </Typography>
                        ))
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {t("common.none")}
                        </Typography>
                      )}
                    </Box>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

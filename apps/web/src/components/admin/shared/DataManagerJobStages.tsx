import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { type AdminTranslator, useAdminTranslations } from "@/lib/admin/adminTranslator";
import { JobStatusChip } from "./JobStatusChip";
import { formatStageError } from "./jobStatus";

export interface DataManagerJobStage {
  id: string;
  stage: string;
  status: string;
  durationMs: number;
  message: string | null;
  error: unknown;
  artifacts?: unknown;
}

function durationLabel(durationMs: number): string {
  if (durationMs < 0 || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function validationDetails(
  stage: DataManagerJobStage,
  t: AdminTranslator<"adminShared">,
): string | null {
  if (stage.stage !== "validate" || !stage.artifacts || typeof stage.artifacts !== "object") {
    return null;
  }
  const invalid = (stage.artifacts as { invalid?: unknown }).invalid;
  if (!Array.isArray(invalid) || invalid.length === 0) return null;

  const details = invalid.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, reason } = entry as { id?: unknown; reason?: unknown };
    if (typeof id !== "string") return [];
    return [`${id}${typeof reason === "string" ? `: ${reason}` : ""}`];
  });
  if (details.length === 0) return null;
  const hidden = details.length - 5;
  const shown = details.slice(0, 5).join("; ");
  return hidden > 0
    ? t("invalidArchivesMore", { archives: shown, hidden })
    : t("invalidArchives", { archives: shown });
}

export function DataManagerJobStages({
  stages,
  emptyMessage,
}: {
  stages: DataManagerJobStage[];
  emptyMessage?: string;
}) {
  const t = useAdminTranslations("adminShared");
  return (
    <Stack sx={{ gap: 0.75 }}>
      <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
        {t("stagesCount", { count: stages.length })}
      </Typography>
      {stages.length === 0 ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {emptyMessage ?? t("noStagesRecorded")}
        </Typography>
      ) : (
        <TableContainer sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("stage")}</TableCell>
                <TableCell>{t("status")}</TableCell>
                <TableCell align="right">{t("duration")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stages.map((stage) => {
                const error = formatStageError(stage.error);
                const artifactDetails = validationDetails(stage, t);
                return (
                  <TableRow key={stage.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {stage.stage.replace(/[_-]/g, " ")}
                      </Typography>
                      {(stage.message || error) && (
                        <Typography
                          variant="caption"
                          sx={{ color: error ? "error.main" : "text.secondary", display: "block" }}
                        >
                          {error ?? stage.message}
                        </Typography>
                      )}
                      {artifactDetails && (
                        <Typography
                          variant="caption"
                          sx={{ color: "warning.main", display: "block" }}
                        >
                          {artifactDetails}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <JobStatusChip status={stage.status} />
                    </TableCell>
                    <TableCell align="right">{durationLabel(stage.durationMs)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}

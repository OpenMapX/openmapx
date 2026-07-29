import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { formatStageError, jobStatusColor } from "./jobStatus";

export interface DataManagerJobStage {
  id: string;
  stage: string;
  status: string;
  durationMs: number;
  message: string | null;
  error: unknown;
}

function durationLabel(durationMs: number): string {
  if (durationMs < 0 || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function DataManagerJobStages({
  stages,
  emptyMessage = "No stages recorded",
}: {
  stages: DataManagerJobStage[];
  emptyMessage?: string;
}) {
  return (
    <Stack sx={{ gap: 0.75 }}>
      <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
        Stages ({stages.length})
      </Typography>
      {stages.length === 0 ? (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {emptyMessage}
        </Typography>
      ) : (
        <TableContainer sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Stage</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stages.map((stage) => {
                const error = formatStageError(stage.error);
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
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={stage.status}
                        color={jobStatusColor(stage.status)}
                        variant="outlined"
                      />
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

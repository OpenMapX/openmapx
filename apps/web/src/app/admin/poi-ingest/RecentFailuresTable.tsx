"use client";

import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { AdminTableSurface } from "@/components/admin/shared/AdminTableSurface";
import { formatPoiAdminTimestamp } from "@/components/admin/shared/adminTimestamp";
import type { PoiIngestStateSummary } from "@/lib/admin/poiIngestHooks";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function RecentFailuresTable({
  state,
  onSelect,
}: {
  state: PoiIngestStateSummary;
  onSelect: (id: string) => void;
}) {
  if (state.recentFailures.length === 0) return null;

  return (
    <AdminTableSurface title={`Recent failures (${state.recentFailures.length})`}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Source ID</TableCell>
              <TableCell align="right">Fails</TableCell>
              <TableCell>Last error</TableCell>
              <TableCell>Last static</TableCell>
              <TableCell>Last live</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {state.recentFailures.map((row) => (
              <TableRow
                key={row.sourceId}
                hover
                sx={{ cursor: "pointer" }}
                onClick={() => onSelect(row.sourceId)}
              >
                <TableCell>
                  <Stack spacing={0.25}>
                    <Typography
                      variant="body2"
                      sx={{
                        fontFamily: "monospace",
                      }}
                    >
                      {row.sourceId}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {row.domain}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell align="right">{row.consecutiveFailures}</TableCell>
                <TableCell>
                  {row.lastError ? (
                    <Tooltip title={row.lastError.message}>
                      <Typography variant="caption" color="error">
                        {truncate(row.lastError.message, 200)}
                      </Typography>
                    </Tooltip>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <Typography variant="caption">
                    {formatPoiAdminTimestamp(row.lastStaticIngestAt)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption">
                    {formatPoiAdminTimestamp(row.lastLiveIngestAt)}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </AdminTableSurface>
  );
}

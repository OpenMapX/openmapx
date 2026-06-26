"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useRefreshRepo, useRemoveRepo, useServiceRepos } from "@/hooks/useServiceRepos";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useClientPagination } from "../shared/tableHooks";
import { AddRepoDialog } from "./AddRepoDialog";

export function ServiceRepoList() {
  const { data, isLoading, isError } = useServiceRepos();
  const remove = useRemoveRepo();
  const refresh = useRefreshRepo();
  const [dialogOpen, setDialogOpen] = useState(false);
  const repos = data?.repos ?? [];
  const { paged, paginationProps } = useClientPagination(repos);

  return (
    <Box>
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          mb: 3,
        }}
      >
        <Typography
          variant="h5"
          sx={{
            fontWeight: 700,
            flex: 1,
          }}
        >
          Service Repositories
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
          Add
        </Button>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        Community service repositories are Git URLs that contain service manifests. Services from
        community repos are not reviewed by OpenMapX.
      </Typography>
      {isLoading && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            py: 4,
          }}
        >
          <CircularProgress />
        </Box>
      )}
      {isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load service repositories.
        </Alert>
      )}
      {!isLoading && !isError && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>URL</TableCell>
                <TableCell>Last fetched</TableCell>
                <TableCell>SHA</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {repos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        py: 2,
                        textAlign: "center",
                      }}
                    >
                      No repositories registered. Click "Add" to register a community service repo.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((r) => (
                  <TableRow key={r.hash}>
                    <TableCell>
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{
                          fontFamily: "monospace",
                          maxWidth: 400,
                        }}
                      >
                        {r.url}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {r.lastFetchedAt ? new Date(r.lastFetchedAt).toLocaleString() : "—"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        sx={{
                          fontFamily: "monospace",
                          color: "text.secondary",
                        }}
                      >
                        {r.lastSha?.slice(0, 8) ?? "—"}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction="row"
                        sx={{
                          justifyContent: "flex-end",
                          gap: 0.5,
                        }}
                      >
                        <Tooltip title="Pull latest changes">
                          <IconButton
                            size="small"
                            onClick={() => refresh.mutate(r.hash)}
                            disabled={refresh.isPending}
                          >
                            <RefreshIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Remove repository">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => remove.mutate(r.hash)}
                            disabled={remove.isPending}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <AdminTablePagination {...paginationProps} />
        </TableContainer>
      )}
      <AddRepoDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </Box>
  );
}

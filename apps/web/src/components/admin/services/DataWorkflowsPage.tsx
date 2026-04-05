"use client";

import BuildIcon from "@mui/icons-material/Build";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

// ---- Types ----------------------------------------------------------------

interface OsmInfo {
  found: boolean;
  filename?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  region?: string;
}

interface BuildStatus {
  target: string;
  built: boolean;
  builtAt?: string;
}

interface GtfsFeed {
  slug: string;
  name: string;
  url: string;
  source?: string;
  status: string;
  importedAt?: string;
  rowCounts?: { stops?: number; routes?: number; trips?: number };
}

interface DataResponse {
  osm: OsmInfo;
  builds: BuildStatus[];
  gtfsFeeds: GtfsFeed[];
  fetchedAt: string;
}

// ---- Helpers --------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BUILD_LABELS: Record<string, string> = {
  valhalla: "Valhalla",
  osrm: "OSRM",
  otp: "OpenTripPlanner",
  motis: "MOTIS",
  tiles: "Tile Server",
  pelias: "Pelias",
  nominatim: "Nominatim",
  photon: "Photon",
  overpass: "Overpass",
};

// ---- OsmSection -----------------------------------------------------------

function OsmSection({ osm }: { osm: OsmInfo }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <StorageIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          OSM Planet Data
        </Typography>
      </Stack>

      {osm.found ? (
        <Stack spacing={1}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <Box>
              <Typography variant="caption" color="text.secondary">
                File
              </Typography>
              <Typography variant="body2" fontFamily="monospace">
                {osm.filename}
              </Typography>
            </Box>
            {osm.region && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Region
                </Typography>
                <Typography variant="body2">{osm.region}</Typography>
              </Box>
            )}
            {osm.sizeBytes && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Size
                </Typography>
                <Typography variant="body2">{formatBytes(osm.sizeBytes)}</Typography>
              </Box>
            )}
            {osm.modifiedAt && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Downloaded
                </Typography>
                <Typography variant="body2">{formatDate(osm.modifiedAt)}</Typography>
              </Box>
            )}
          </Stack>
          <Chip
            icon={<CheckCircleIcon />}
            label="OSM PBF present"
            color="success"
            size="small"
            sx={{ width: "fit-content" }}
          />
        </Stack>
      ) : (
        <Alert severity="warning" sx={{ mb: 1 }}>
          No OSM PBF file found in the data directory. Run{" "}
          <code>./manage.sh download-osm &lt;region&gt;</code> to download.
        </Alert>
      )}
    </Paper>
  );
}

// ---- BuildsSection --------------------------------------------------------

function BuildsSection({
  builds,
  onBuild,
  pendingTarget,
}: {
  builds: BuildStatus[];
  onBuild: (target: string) => void;
  pendingTarget: string | null;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <BuildIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          Service Builds
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Build search indexes and routing graphs from OSM/GTFS data
        </Typography>
      </Stack>

      <Grid container spacing={2}>
        {builds.map((b) => (
          <Grid key={b.target} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card variant="outlined">
              <CardContent sx={{ pb: "12px !important" }}>
                <Stack direction="row" alignItems="center" spacing={1} mb={1}>
                  {b.built ? (
                    <CheckCircleIcon fontSize="small" sx={{ color: "success.main" }} />
                  ) : (
                    <HelpOutlineIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  )}
                  <Typography variant="body2" fontWeight={600}>
                    {BUILD_LABELS[b.target] ?? b.target}
                  </Typography>
                </Stack>
                {b.builtAt && (
                  <Typography variant="caption" color="text.secondary" display="block" mb={1}>
                    Built {formatDate(b.builtAt)}
                  </Typography>
                )}
                {!b.built && (
                  <Typography variant="caption" color="text.secondary" display="block" mb={1}>
                    Not built
                  </Typography>
                )}
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={
                    pendingTarget === b.target ? <CircularProgress size={14} /> : <BuildIcon />
                  }
                  disabled={pendingTarget === b.target}
                  onClick={() => onBuild(b.target)}
                  fullWidth
                >
                  {b.built ? "Rebuild" : "Build"}
                </Button>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Alert severity="info" sx={{ mt: 2 }}>
        Build jobs run in the background. Monitor progress in{" "}
        <Link href="/admin/activity">Activity → Jobs</Link>.
      </Alert>
    </Paper>
  );
}

// ---- GtfsSection ----------------------------------------------------------

function GtfsSection({ feeds, apiUrl }: { feeds: GtfsFeed[]; apiUrl: string }) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);

  const removeMutation = useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`${apiUrl}/api/gtfs/feeds/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove feed");
    },
    onSuccess: (_, slug) => {
      setToast(`Feed "${slug}" removed.`);
      void queryClient.invalidateQueries({ queryKey: ["admin-services-data"] });
    },
    onError: () => setToast("Failed to remove feed."),
  });

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <FileDownloadIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          GTFS Feeds
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          component={Link}
          href="/admin/integrations/transit-gtfs-local"
          variant="outlined"
          size="small"
        >
          Manage Feeds
        </Button>
      </Stack>

      {feeds.length === 0 ? (
        <Alert severity="info">No GTFS feeds imported yet.</Alert>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Slug</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Stops</TableCell>
                <TableCell>Routes</TableCell>
                <TableCell>Imported</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {feeds.map((feed) => (
                <TableRow key={feed.slug} hover>
                  <TableCell>
                    <Typography variant="caption" fontFamily="monospace">
                      g-{feed.slug}
                    </Typography>
                  </TableCell>
                  <TableCell>{feed.name}</TableCell>
                  <TableCell>
                    <Chip
                      label={feed.status}
                      size="small"
                      color={
                        feed.status === "ready"
                          ? "success"
                          : feed.status === "importing"
                            ? "warning"
                            : "default"
                      }
                    />
                  </TableCell>
                  <TableCell>{feed.rowCounts?.stops?.toLocaleString() ?? "—"}</TableCell>
                  <TableCell>{feed.rowCounts?.routes?.toLocaleString() ?? "—"}</TableCell>
                  <TableCell>{feed.importedAt ? formatDate(feed.importedAt) : "—"}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Remove feed">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => removeMutation.mutate(feed.slug)}
                        disabled={removeMutation.isPending}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Paper>
  );
}

// ---- Main component -------------------------------------------------------

export function DataWorkflowsPage() {
  const { apiUrl } = useEnv();
  const queryClient = useQueryClient();

  const [pendingBuild, setPendingBuild] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DataResponse>({
    queryKey: ["admin-services-data"],
    queryFn: () =>
      fetch(`${apiUrl}/api/admin/services/data`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const buildMutation = useMutation({
    mutationFn: async (target: string) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/data/build/${encodeURIComponent(target)}`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`Build request failed: HTTP ${res.status}`);
      return res.json() as Promise<{ ok: boolean; jobId: string }>;
    },
    onSuccess: (result, target) => {
      setToast(`Build job queued for "${target}" (job ${result.jobId.slice(0, 8)})`);
      setPendingBuild(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-services-data"] });
    },
    onError: (_, target) => {
      setToast(`Failed to start build for "${target}".`);
      setPendingBuild(null);
    },
  });

  const handleBuild = (target: string) => {
    setPendingBuild(target);
    buildMutation.mutate(target);
  };

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return <Alert severity="error">Failed to load data inventory.</Alert>;
  }

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Data &amp; Feed Workflows
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage OSM data, GTFS feeds, and service build indexes
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={() => refetch()} disabled={isFetching}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Button component={Link} href="/admin/services" variant="outlined" size="small">
          ← Services
        </Button>
      </Stack>

      <Stack spacing={3}>
        <OsmSection osm={data.osm} />
        <GtfsSection feeds={data.gtfsFeeds} apiUrl={apiUrl} />
        <BuildsSection builds={data.builds} onBuild={handleBuild} pendingTarget={pendingBuild} />
      </Stack>

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Box>
  );
}

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

// Types

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

interface MotisTransitousStatus {
  configFound: boolean;
  datasetCount: number;
  realtimeFeedCount: number;
  gbfsFeedCount: number;
  feedProxyUrlCount: number;
  feedProxyMode: "none" | "self-hosted" | "transitous-cloud" | "mixed";
  feedProxyConfigFound: boolean;
  feedProxyVarsFound: boolean;
  feedProxyFeedCount: number;
}

interface DataResponse {
  osm: OsmInfo;
  builds: BuildStatus[];
  gtfsFeeds: GtfsFeed[];
  motisTransitous: MotisTransitousStatus;
  fetchedAt: string;
}

// Helpers

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
  motisFeedProxy: "MOTIS Feed Proxy",
  tiles: "Tile Server",
  pelias: "Pelias",
  nominatim: "Nominatim",
  photon: "Photon",
  overpass: "Overpass",
};

// OsmSection

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
          <code>pnpm openmapx data download osm &lt;region&gt;</code> to download.
        </Alert>
      )}
    </Paper>
  );
}

// BuildsSection

function BuildsSection({ builds }: { builds: BuildStatus[] }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <BuildIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          Service Build Inventory
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Read-only view of which services have populated their data dirs
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
                  <Typography variant="caption" color="text.secondary" display="block">
                    Built {formatDate(b.builtAt)}
                  </Typography>
                )}
                {!b.built && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    Not built
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Alert severity="info" sx={{ mt: 2 }}>
        Each service builds its own indexes/graphs on first start (Valhalla auto-builds tiles,
        Nominatim auto-imports, OSRM runs its extract/partition/customize chain, etc.). Trigger a
        rebuild by stopping the service from the <Link href="/admin/services">service catalog</Link>{" "}
        and starting it again, or via{" "}
        <code>
          pnpm openmapx services stop &lt;id&gt; && pnpm openmapx services start &lt;id&gt;
        </code>
        .
      </Alert>
    </Paper>
  );
}

// GtfsSection

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

function motisProxyModeColor(
  mode: MotisTransitousStatus["feedProxyMode"],
): "default" | "success" | "warning" | "error" {
  if (mode === "self-hosted") return "success";
  if (mode === "none") return "default";
  if (mode === "mixed") return "warning";
  return "error";
}

function MotisTransitousSection({ status }: { status: MotisTransitousStatus }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <StorageIcon color="primary" />
        <Typography variant="h6" fontWeight={600}>
          MOTIS Transitous Parity
        </Typography>
      </Stack>

      {!status.configFound ? (
        <Alert severity="warning">
          No MOTIS config found yet. Run <code>pnpm openmapx services build motis</code> after
          downloading GTFS.
        </Alert>
      ) : (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <Chip label={`${status.datasetCount} schedule dataset(s)`} size="small" />
            <Chip label={`${status.realtimeFeedCount} realtime feed(s)`} size="small" />
            <Chip label={`${status.gbfsFeedCount} GBFS feed(s)`} size="small" />
            <Chip label={`${status.feedProxyUrlCount} proxied URL(s)`} size="small" />
            <Chip
              label={`Feed proxy: ${status.feedProxyMode}`}
              color={motisProxyModeColor(status.feedProxyMode)}
              size="small"
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Proxy artifacts: config {status.feedProxyConfigFound ? "present" : "missing"} · vars{" "}
            {status.feedProxyVarsFound ? "present" : "missing"} · {status.feedProxyFeedCount} mapped
            feed endpoint(s)
          </Typography>
          {(status.feedProxyMode === "transitous-cloud" || status.feedProxyMode === "mixed") && (
            <Alert severity={status.feedProxyMode === "mixed" ? "warning" : "error"}>
              MOTIS config still references Transitous cloud feed-proxy URLs. Rebuild MOTIS data to
              switch fully to self-hosted proxy URLs.
            </Alert>
          )}
        </Stack>
      )}
    </Paper>
  );
}

// Main component

export function DataWorkflowsPage() {
  const { apiUrl } = useEnv();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DataResponse>({
    queryKey: ["admin-services-data"],
    queryFn: () =>
      fetch(`${apiUrl}/api/admin/services/data`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });

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
        <MotisTransitousSection status={data.motisTransitous} />
        <BuildsSection builds={data.builds} />
      </Stack>
    </Box>
  );
}

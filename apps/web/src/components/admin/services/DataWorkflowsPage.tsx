"use client";

import BuildIcon from "@mui/icons-material/Build";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { formatBytes } from "@/lib/storageFormat";
import { useAdminToast } from "../shared/AdminToast";

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
  /** Upstream HTTP URL when `url` is a `local:` pseudo-URL — null for direct URL imports. */
  originUrl?: string | null;
  source?: string;
  status: string;
  importedAt?: string;
  /** Live importer stage label (e.g. "importing stop_times") while status is `downloading`/`importing`. */
  currentStage?: string | null;
  errorMessage?: string | null;
  /** ISO `YYYY-MM-DD` — last calendar date the feed schedules service for. */
  serviceEndDate?: string | null;
  rowCounts?: { stops?: number; routes?: number; trips?: number };
}

interface MotisGtfsArchive {
  /** Filename minus .gtfs.zip / .netex.zip — matches against Postgres slugs case-insensitively. */
  id: string;
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  format: "gtfs" | "netex";
  /** Upstream HTTP URL the archive was fetched from, derived from the Transitous catalog. */
  originUrl?: string;
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
  motisGtfsArchives?: MotisGtfsArchive[];
  motisTransitous: MotisTransitousStatus;
  fetchedAt: string;
}

interface DataActionResponse {
  ok: boolean;
  jobId: string;
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

function renderExpiryCell(serviceEndDate: string | null | undefined): ReactNode {
  if (!serviceEndDate) return "—";
  // The service end date is a UTC calendar day; compare against today's UTC
  // calendar day so a feed valid through "today" doesn't show as expired
  // depending on the operator's timezone offset.
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const [y, m, d] = serviceEndDate.split("-").map(Number);
  if (!y || !m || !d) return "—";
  const endUtc = Date.UTC(y, m - 1, d);
  const daysUntil = Math.round((endUtc - todayUtc) / 86_400_000);
  const formatted = new Date(endUtc).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  let color: "default" | "success" | "warning" | "error" = "default";
  let label = formatted;
  if (daysUntil < 0) {
    color = "error";
    label = `${formatted} · expired ${-daysUntil}d ago`;
  } else if (daysUntil < 7) {
    color = "error";
    label = `${formatted} · ${daysUntil}d`;
  } else if (daysUntil < 30) {
    color = "warning";
    label = `${formatted} · ${daysUntil}d`;
  } else {
    color = "success";
    label = `${formatted} · ${daysUntil}d`;
  }
  return <Chip size="small" color={color} variant="outlined" label={label} />;
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

function OperationCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Box>
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 700,
              }}
            >
              {title}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {description}
            </Typography>
          </Box>
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}

function DataOperationsSection({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const queryClient = useQueryClient();

  const [osmRegion, setOsmRegion] = useState("");
  const [gtfsCountries, setGtfsCountries] = useState("");
  const [gtfsFeedsFile, setGtfsFeedsFile] = useState("");
  const [updateRegion, setUpdateRegion] = useState("");
  const [updateCountries, setUpdateCountries] = useState("");
  const [updateFeedsFile, setUpdateFeedsFile] = useState("");
  const [updateFailFast, setUpdateFailFast] = useState(false);
  const [overpassRegion, setOverpassRegion] = useState("");
  const [cleanTarget, setCleanTarget] = useState("all");
  const [cleanDialogOpen, setCleanDialogOpen] = useState(false);
  const [apiKeysRepoUrl, setApiKeysRepoUrl] = useState("");
  const [apiKeysOutput, setApiKeysOutput] = useState("");
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const runOperation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`${apiUrl}/api/admin/services/data/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to queue operation");
      }
      return res.json() as Promise<DataActionResponse>;
    },
    onSuccess: (result, body) => {
      const op = String(body.operation ?? "operation");
      setLastJobId(result.jobId);
      showToast(`Queued ${op} (${result.jobId})`);
      queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
      queryClient.invalidateQueries({ queryKey: ["admin-services-data"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Operation failed", "error"),
  });

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <BuildIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          Data Operations
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button component={Link} href="/admin/activity" variant="outlined" size="small">
          Open Activity
        </Button>
      </Stack>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        Queue CLI-backed data jobs from the GUI. All operations stream logs via Admin jobs.
      </Typography>
      {lastJobId && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button component={Link} href="/admin/activity" size="small" color="inherit">
              View Jobs
            </Button>
          }
        >
          Last queued job: <code>{lastJobId}</code>
        </Alert>
      )}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Download OSM"
            description="Runs: openmapx data download osm [region]"
          >
            <TextField
              size="small"
              label="Region"
              placeholder="e.g. germany"
              value={osmRegion}
              onChange={(e) => setOsmRegion(e.target.value)}
            />
            <Button
              variant="contained"
              onClick={() => runOperation.mutate({ operation: "download-osm", region: osmRegion })}
              disabled={runOperation.isPending}
            >
              Queue OSM Download
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Download GTFS"
            description="Runs: openmapx data download gtfs [--countries] [--feeds-file]"
          >
            <TextField
              size="small"
              label="Countries"
              placeholder="de,at,ch"
              value={gtfsCountries}
              onChange={(e) => setGtfsCountries(e.target.value)}
            />
            <TextField
              size="small"
              label="Feeds file"
              placeholder="/path/to/feeds.json"
              value={gtfsFeedsFile}
              onChange={(e) => setGtfsFeedsFile(e.target.value)}
            />
            <Button
              variant="contained"
              onClick={() =>
                runOperation.mutate({
                  operation: "download-gtfs",
                  countries: gtfsCountries,
                  feedsFile: gtfsFeedsFile,
                })
              }
              disabled={runOperation.isPending}
            >
              Queue GTFS Download
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Download Style Assets"
            description="Runs: openmapx data download style"
          >
            <Button
              variant="contained"
              onClick={() => runOperation.mutate({ operation: "download-style" })}
              disabled={runOperation.isPending}
            >
              Queue Style Download
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Full Update Pipeline"
            description="Runs: openmapx data update [region] and dependent build/link steps"
          >
            <TextField
              size="small"
              label="Region"
              placeholder="e.g. germany"
              value={updateRegion}
              onChange={(e) => setUpdateRegion(e.target.value)}
            />
            <TextField
              size="small"
              label="Countries"
              placeholder="de,at,ch"
              value={updateCountries}
              onChange={(e) => setUpdateCountries(e.target.value)}
            />
            <TextField
              size="small"
              label="Feeds file"
              placeholder="/path/to/feeds.json"
              value={updateFeedsFile}
              onChange={(e) => setUpdateFeedsFile(e.target.value)}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={updateFailFast}
                  onChange={(e) => setUpdateFailFast(e.target.checked)}
                />
              }
              label="Fail fast"
            />
            <Button
              variant="contained"
              onClick={() =>
                runOperation.mutate({
                  operation: "update",
                  region: updateRegion,
                  countries: updateCountries,
                  feedsFile: updateFeedsFile,
                  failFast: updateFailFast,
                })
              }
              disabled={runOperation.isPending}
            >
              Queue Update Pipeline
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Convert for Overpass"
            description="Runs: openmapx data convert overpass [region]"
          >
            <TextField
              size="small"
              label="Region"
              placeholder="e.g. germany"
              value={overpassRegion}
              onChange={(e) => setOverpassRegion(e.target.value)}
            />
            <Button
              variant="contained"
              onClick={() =>
                runOperation.mutate({ operation: "convert-overpass", region: overpassRegion })
              }
              disabled={runOperation.isPending}
            >
              Queue Overpass Convert
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Hardlink Sync"
            description="Runs: openmapx data link (apply/prune hardlink plan)"
          >
            <Button
              variant="contained"
              onClick={() => runOperation.mutate({ operation: "link" })}
              disabled={runOperation.isPending}
            >
              Queue Hardlink Sync
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Cleanup Data"
            description="Runs: openmapx data clean <target> (destructive)"
          >
            <TextField
              size="small"
              label="Target"
              placeholder="all | osm | gtfs | overpass ..."
              value={cleanTarget}
              onChange={(e) => setCleanTarget(e.target.value)}
            />
            <Button
              variant="contained"
              color="warning"
              onClick={() => setCleanDialogOpen(true)}
              disabled={runOperation.isPending || !cleanTarget.trim()}
            >
              Queue Cleanup
            </Button>
          </OperationCard>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <OperationCard
            title="Generate Transitous API-Key Template"
            description="Runs: openmapx data generate-api-keys"
          >
            <TextField
              size="small"
              label="Transitous repo URL"
              placeholder="https://github.com/public-transport/transitous"
              value={apiKeysRepoUrl}
              onChange={(e) => setApiKeysRepoUrl(e.target.value)}
            />
            <TextField
              size="small"
              label="Output path"
              placeholder="services/motis/tools/transitous/api-keys.json"
              value={apiKeysOutput}
              onChange={(e) => setApiKeysOutput(e.target.value)}
            />
            <Button
              variant="contained"
              onClick={() =>
                runOperation.mutate({
                  operation: "generate-api-keys",
                  repoUrl: apiKeysRepoUrl,
                  output: apiKeysOutput,
                })
              }
              disabled={runOperation.isPending}
            >
              Queue API-Key Template
            </Button>
          </OperationCard>
        </Grid>
      </Grid>
      <Dialog
        open={cleanDialogOpen}
        onClose={() => setCleanDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Confirm Data Cleanup</DialogTitle>
        <DialogContent>
          <Stack
            sx={{
              gap: 1.5,
              pt: 0.5,
            }}
          >
            <Alert severity="warning">
              This operation removes local data files and may require full rebuilds.
            </Alert>
            <Typography variant="body2">
              Target: <strong>{cleanTarget || "(empty)"}</strong>
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCleanDialogOpen(false)} disabled={runOperation.isPending}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            disabled={runOperation.isPending || !cleanTarget.trim()}
            onClick={() => {
              runOperation.mutate({ operation: "clean", target: cleanTarget.trim() });
              setCleanDialogOpen(false);
            }}
          >
            {runOperation.isPending ? "Queueing..." : "Confirm Cleanup"}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

function OsmSection({ osm }: { osm: OsmInfo }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <StorageIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          OSM Planet Data
        </Typography>
      </Stack>
      {osm.found ? (
        <Stack spacing={1}>
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            <Box>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                File
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: "monospace",
                }}
              >
                {osm.filename}
              </Typography>
            </Box>
            {osm.region && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Region
                </Typography>
                <Typography variant="body2">{osm.region}</Typography>
              </Box>
            )}
            {osm.sizeBytes && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  Size
                </Typography>
                <Typography variant="body2">{formatBytes(osm.sizeBytes)}</Typography>
              </Box>
            )}
            {osm.modifiedAt && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
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
          No OSM PBF file found in the data directory. Queue an OSM download above.
        </Alert>
      )}
    </Paper>
  );
}

function BuildsSection({ builds }: { builds: BuildStatus[] }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <BuildIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          Service Build Inventory
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          Read-only view of which services have populated their data dirs
        </Typography>
      </Stack>
      <Grid container spacing={2}>
        {builds.map((b) => (
          <Grid key={b.target} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card variant="outlined">
              <CardContent sx={{ pb: "12px !important" }}>
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    alignItems: "center",
                    mb: 1,
                  }}
                >
                  {b.built ? (
                    <CheckCircleIcon fontSize="small" sx={{ color: "success.main" }} />
                  ) : (
                    <HelpOutlineIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  )}
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                    }}
                  >
                    {BUILD_LABELS[b.target] ?? b.target}
                  </Typography>
                </Stack>
                {b.builtAt && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: "block",
                    }}
                  >
                    Built {formatDate(b.builtAt)}
                  </Typography>
                )}
                {!b.built && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: "block",
                    }}
                  >
                    Not built
                  </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
      <Alert severity="info" sx={{ mt: 2 }}>
        Each service builds its own indexes/graphs on first start. Trigger rebuilds from the service
        catalog or queue data update/build operations.
      </Alert>
    </Paper>
  );
}

// One row per logical feed. A feed counts as the "same" feed across stores
// when its slug (Postgres) matches the MOTIS archive id case-insensitively
// — that's how the GTFS importer normalises names anyway.
interface UnifiedGtfsRow {
  /** Display key: feed slug if imported, otherwise the MOTIS archive id. */
  key: string;
  postgres?: GtfsFeed;
  motis?: MotisGtfsArchive;
}

function buildUnifiedRows(feeds: GtfsFeed[], archives: MotisGtfsArchive[]): UnifiedGtfsRow[] {
  const byKey = new Map<string, UnifiedGtfsRow>();
  for (const feed of feeds) {
    const key = feed.slug.toLowerCase();
    byKey.set(key, { key: feed.slug, postgres: feed });
  }
  for (const archive of archives) {
    const key = archive.id.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.motis = archive;
    } else {
      byKey.set(key, { key: archive.id, motis: archive });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function GtfsSection({
  feeds,
  motisArchives,
  apiUrl,
}: {
  feeds: GtfsFeed[];
  motisArchives: MotisGtfsArchive[];
  apiUrl: string;
}) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importSlug, setImportSlug] = useState("");
  const [importName, setImportName] = useState("");

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

  const importMutation = useMutation({
    mutationFn: async (input: {
      url?: string;
      motisArchiveId?: string;
      slug?: string;
      name?: string;
    }) => {
      const res = await fetch(`${apiUrl}/api/gtfs/feeds`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: input.url?.trim() || undefined,
          motisArchiveId: input.motisArchiveId,
          slug: input.slug?.trim() || undefined,
          name: input.name?.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        slug?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Import failed (HTTP ${res.status})`);
      return body.slug;
    },
    onSuccess: (slug) => {
      setToast(`Import started for "${slug}". Watch the table for progress.`);
      setImportOpen(false);
      setImportUrl("");
      setImportSlug("");
      setImportName("");
      void queryClient.invalidateQueries({ queryKey: ["admin-services-data"] });
    },
    onError: (err) => setToast((err as Error).message),
  });

  // MOTIS-only rows (no Postgres counterpart) — used by the bulk-import action.
  const motisOnlyArchives = motisArchives.filter(
    (archive) => !feeds.some((feed) => feed.slug.toLowerCase() === archive.id.toLowerCase()),
  );

  const bulkPromoteRunning = importMutation.isPending;
  const bulkPromote = () => {
    // Fire imports sequentially so the importer's per-feed mutex
    // (`isImporting`) doesn't reject parallel attempts on the same slug
    // and the data-manager's CPU/disk doesn't get hammered by 5 concurrent
    // unzips. The mutation queue is a tiny finite-state loop — each `mutate`
    // call hands off to the API, returns immediately, and the next iteration
    // waits via `await` on the same promise the React mutation observes.
    void (async () => {
      for (const archive of motisOnlyArchives) {
        try {
          await importMutation.mutateAsync({ motisArchiveId: archive.id });
        } catch (err) {
          // Single failure shouldn't abort the rest of the batch — they're
          // independent feeds. The mutation's onError already toasts.
          console.error(`[gtfs] bulk import failed for ${archive.id}:`, err);
        }
      }
    })();
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <FileDownloadIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          GTFS Feeds
        </Typography>
        <Box sx={{ flex: 1 }} />
        {motisOnlyArchives.length > 0 && (
          <Tooltip
            title={
              "Promote every MOTIS-only feed into Postgres in one go. Imports run sequentially; each one is the same `motisArchiveId` flow as the per-row button."
            }
          >
            <span>
              <Button
                variant="outlined"
                size="small"
                disabled={bulkPromoteRunning}
                onClick={bulkPromote}
              >
                Import all {motisOnlyArchives.length} to Postgres
              </Button>
            </span>
          </Tooltip>
        )}
        <Button variant="contained" size="small" onClick={() => setImportOpen(true)}>
          Import feed
        </Button>
      </Stack>
      <Dialog open={importOpen} onClose={() => setImportOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Import GTFS feed</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              Paste the URL of a GTFS .zip. The importer will stream the archive, parse the CSVs,
              and load them into a dedicated `gtfs_&lt;slug&gt;` Postgres schema. Slug is
              auto-derived from the URL filename if you leave it blank.
            </Typography>
            <TextField
              label="GTFS zip URL"
              placeholder="https://example.com/feed.gtfs.zip"
              fullWidth
              size="small"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              autoFocus
            />
            <TextField
              label="Slug (optional)"
              placeholder="vbb"
              helperText="Used as the Postgres schema name (gtfs_<slug>) and the gtfs-local provider prefix (g-<slug>:). Lowercase letters, digits, hyphens, underscores."
              fullWidth
              size="small"
              value={importSlug}
              onChange={(e) => setImportSlug(e.target.value)}
            />
            <TextField
              label="Display name (optional)"
              placeholder="VBB Berlin-Brandenburg"
              fullWidth
              size="small"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportOpen(false)} disabled={importMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!importUrl.trim() || importMutation.isPending}
            onClick={() =>
              importMutation.mutate({
                url: importUrl,
                slug: importSlug,
                name: importName,
              })
            }
          >
            {importMutation.isPending ? "Starting…" : "Start import"}
          </Button>
        </DialogActions>
      </Dialog>
      {(() => {
        const rows = buildUnifiedRows(feeds, motisArchives);
        if (rows.length === 0) {
          return (
            <Alert severity="info">
              No GTFS feeds yet. Either run{" "}
              <Box component="code" sx={{ fontFamily: "monospace" }}>
                pnpm openmapx data download gtfs --countries de
              </Box>{" "}
              to populate MOTIS, or click <strong>Import feed</strong> to load a single feed into
              Postgres for SQL-based stop search.
            </Alert>
          );
        }
        return (
          <>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                display: "block",
                mb: 1,
              }}
            >
              <strong>MOTIS</strong> = raw GTFS zip on disk consumed by the MOTIS engine at startup
              (transit routing). <strong>Postgres</strong> = imported into a dedicated schema for
              SQL-based stop/route lookups (place panel, transit-gtfs-local provider). The same
              upstream feed can live in either or both.
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Feed</TableCell>
                    <TableCell>Stores</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Stops</TableCell>
                    <TableCell>Routes</TableCell>
                    <TableCell>Expires</TableCell>
                    <TableCell>Updated</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const pg = row.postgres;
                    const motis = row.motis;
                    const displayName = pg?.name ?? motis?.id ?? row.key;
                    const updatedIso = pg?.importedAt ?? motis?.modifiedAt;
                    // Prefer the Postgres-recorded origin (it survives MOTIS-side cleanup) and
                    // fall back to the catalog-derived MOTIS archive URL when the feed only
                    // exists on disk.
                    const originUrl = pg?.originUrl ?? motis?.originUrl ?? null;
                    const status = pg?.status ?? (motis ? "motis-only" : "—");
                    const statusColor: "success" | "warning" | "default" | "info" =
                      status === "active"
                        ? "success"
                        : status === "importing" || status === "downloading"
                          ? "warning"
                          : status === "motis-only"
                            ? "info"
                            : "default";
                    return (
                      <TableRow key={row.key} hover>
                        <TableCell>
                          <Stack spacing={0.25}>
                            <Typography variant="body2">{displayName}</Typography>
                            <Typography
                              variant="caption"
                              sx={{
                                color: "text.secondary",
                                fontFamily: "monospace",
                              }}
                            >
                              {pg ? `g-${pg.slug}` : row.key}
                              {motis ? ` · ${formatBytes(motis.sizeBytes)}` : ""}
                            </Typography>
                            {originUrl && (
                              <Tooltip title={originUrl}>
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.secondary",
                                    maxWidth: 280,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  origin:{" "}
                                  <Box
                                    component="a"
                                    href={originUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    sx={{ color: "inherit", textDecoration: "underline" }}
                                  >
                                    {originUrl}
                                  </Box>
                                </Typography>
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5}>
                            {motis && <Chip label="MOTIS" size="small" variant="outlined" />}
                            {pg && (
                              <Chip
                                label="Postgres"
                                size="small"
                                color="primary"
                                variant="outlined"
                              />
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Stack spacing={0.25}>
                            <Chip label={status} size="small" color={statusColor} />
                            {pg?.currentStage &&
                              (status === "importing" || status === "downloading") && (
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.secondary",
                                    pl: 0.25,
                                  }}
                                >
                                  {pg.currentStage}
                                </Typography>
                              )}
                            {pg?.errorMessage && status === "failed" && (
                              <Tooltip title={pg.errorMessage}>
                                <Typography
                                  variant="caption"
                                  color="error"
                                  sx={{
                                    pl: 0.25,
                                    maxWidth: 200,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    cursor: "help",
                                  }}
                                >
                                  {pg.errorMessage}
                                </Typography>
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>{pg?.rowCounts?.stops?.toLocaleString() ?? "—"}</TableCell>
                        <TableCell>{pg?.rowCounts?.routes?.toLocaleString() ?? "—"}</TableCell>
                        <TableCell>{renderExpiryCell(pg?.serviceEndDate)}</TableCell>
                        <TableCell>{updatedIso ? formatDate(updatedIso) : "—"}</TableCell>
                        <TableCell align="right">
                          <Stack
                            direction="row"
                            spacing={0.5}
                            sx={{
                              justifyContent: "flex-end",
                            }}
                          >
                            {!pg && motis && (
                              <Tooltip title="Promote this MOTIS-fetched archive into Postgres (no re-download — apps/api reads the local zip directly)">
                                <span>
                                  <Button
                                    size="small"
                                    disabled={importMutation.isPending}
                                    onClick={() =>
                                      importMutation.mutate({ motisArchiveId: motis.id })
                                    }
                                  >
                                    Import to Postgres
                                  </Button>
                                </span>
                              </Tooltip>
                            )}
                            {pg && (
                              <Tooltip title="Remove from Postgres (the MOTIS zip on disk is untouched)">
                                <IconButton
                                  size="small"
                                  color="error"
                                  onClick={() => removeMutation.mutate(pg.slug)}
                                  disabled={removeMutation.isPending}
                                >
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        );
      })()}
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
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 2,
        }}
      >
        <StorageIcon color="primary" />
        <Typography
          variant="h6"
          sx={{
            fontWeight: 600,
          }}
        >
          MOTIS Transitous Parity
        </Typography>
      </Stack>
      {!status.configFound ? (
        <Alert severity="warning">
          No MOTIS config found yet. Queue GTFS/OSM operations and build MOTIS data.
        </Alert>
      ) : (
        <Stack spacing={1.5}>
          <Stack
            direction="row"
            spacing={2}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
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
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
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

export function DataWorkflowsPage() {
  const { apiUrl } = useEnv();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DataResponse>({
    queryKey: ["admin-services-data"],
    queryFn: () =>
      fetch(`${apiUrl}/api/admin/services/data`, { credentials: "include" }).then((r) => r.json()),
    // Tighten the refetch cadence to 3s whenever a GTFS import is mid-flight
    // so the live `currentStage` progress label updates in close to real time.
    // Falls back to the lazy 30s interval otherwise.
    refetchInterval: (query) => {
      const latest = query.state.data;
      const inFlight = latest?.gtfsFeeds.some(
        (f) => f.status === "downloading" || f.status === "importing",
      );
      return inFlight ? 3_000 : 30_000;
    },
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !data) {
    return <Alert severity="error">Failed to load data inventory.</Alert>;
  }

  return (
    <Box>
      <Stack
        direction="row"
        spacing={2}
        sx={{
          alignItems: "center",
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="h5"
            sx={{
              fontWeight: 700,
            }}
          >
            Data &amp; Feed Workflows
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            Manage OSM data, GTFS feeds, builds, and long-running data jobs
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
        <DataOperationsSection apiUrl={apiUrl} />
        <OsmSection osm={data.osm} />
        <GtfsSection
          feeds={data.gtfsFeeds}
          motisArchives={data.motisGtfsArchives ?? []}
          apiUrl={apiUrl}
        />
        <MotisTransitousSection status={data.motisTransitous} />
        <BuildsSection builds={data.builds} />
      </Stack>
    </Box>
  );
}

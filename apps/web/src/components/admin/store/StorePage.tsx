"use client";

import AddIcon from "@mui/icons-material/Add";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import StarIcon from "@mui/icons-material/Star";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { DomainChip } from "../integrations/DomainChip";
import { useAdminToast } from "../shared/AdminToast";
import { InstallFromUrlDialog } from "./InstallFromUrlDialog";
import type { StoreCatalogEntry } from "./StoreCard";
import { StoreCard } from "./StoreCard";
import { StoreDetailDrawer } from "./StoreDetailDrawer";

// ---- Types -----------------------------------------------------------------

interface CatalogResponse {
  entries: StoreCatalogEntry[];
  total: number;
}

interface InstalledEntry {
  id: string;
  repository: string;
  installedVersion: string;
  sourceType: string;
  installedAt: string;
  updatedAt: string;
  catalogEntry: StoreCatalogEntry | null;
  hasUpdate: boolean;
}

interface InstalledResponse {
  integrations: InstalledEntry[];
}

const SORT_OPTIONS = [
  { value: "az", label: "A–Z" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Recently Updated" },
] as const;

const DOMAIN_OPTIONS = [
  { value: "", label: "All domains" },
  { value: "geocoding", label: "Geocoding" },
  { value: "routing", label: "Routing" },
  { value: "transit", label: "Transit" },
  { value: "street-view", label: "Street View" },
  { value: "map-overlay", label: "Map Overlay" },
  { value: "poi-search", label: "POI Search" },
  { value: "photos", label: "Photos" },
  { value: "enrichment", label: "Enrichment" },
  { value: "data-source", label: "Data Source" },
];

const QUALITY_OPTIONS = [
  { value: "", label: "All quality" },
  { value: "community-verified", label: "Verified" },
  { value: "community", label: "Community" },
];

// ---- Sources types ---------------------------------------------------------

interface CatalogSource {
  url: string;
  label: string;
  isDefault: boolean;
}

// ---- Add Source Dialog ------------------------------------------------------

function AddSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/sources`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, label }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to add source");
      }
      return res.json();
    },
    onSuccess: () => {
      showToast("Catalog source added");
      qc.invalidateQueries({ queryKey: ["store-sources"] });
      setUrl("");
      setLabel("");
      onClose();
    },
    onError: (e) => showToast(e instanceof Error ? e.message : "Failed to add source", "error"),
  });

  const valid = url.trim().length > 0 && label.trim().length > 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add Catalog Source</DialogTitle>
      <DialogContent>
        <Stack gap={2} pt={1}>
          <TextField
            label="Label"
            placeholder="My Company Integrations"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            size="small"
            fullWidth
            autoFocus
          />
          <TextField
            label="Catalog URL"
            placeholder="https://example.com/catalog.json"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            size="small"
            fullWidth
            helperText="URL must point to a JSON array of catalog entries"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={addMutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => addMutation.mutate()}
          disabled={!valid || addMutation.isPending}
        >
          Add Source
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---- Sources tab -----------------------------------------------------------

function SourcesTab() {
  const { apiUrl } = useEnv();
  const [addOpen, setAddOpen] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ sources: CatalogSource[] }>({
    queryKey: ["store-sources"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/sources`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sources");
      return res.json();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(`${apiUrl}/api/admin/store/sources`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error("Failed to remove source");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["store-sources"] }),
  });

  const sources = data?.sources ?? [];

  return (
    <Stack gap={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="body2" color="text.secondary">
          Catalog sources define where integrations are discovered from. The default source is
          always included.
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => setAddOpen(true)}
        >
          Add Source
        </Button>
      </Stack>

      {isLoading ? (
        <CircularProgress size={24} sx={{ mx: "auto", my: 4 }} />
      ) : (
        <Paper variant="outlined">
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Label</TableCell>
                  <TableCell>URL</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map((src) => (
                  <TableRow key={src.url} hover>
                    <TableCell>
                      <Stack direction="row" alignItems="center" gap={0.5}>
                        {src.isDefault && <StarIcon sx={{ fontSize: 14, color: "warning.main" }} />}
                        <Typography variant="body2" fontWeight={src.isDefault ? 600 : 400}>
                          {src.label}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        fontFamily="monospace"
                        color="text.secondary"
                        noWrap
                        sx={{ maxWidth: 360, display: "block" }}
                      >
                        {src.url}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={src.isDefault ? "Default" : "Custom"}
                        size="small"
                        color={src.isDefault ? "primary" : "default"}
                        variant="outlined"
                        sx={{ fontSize: 11, height: 20 }}
                      />
                    </TableCell>
                    <TableCell align="right">
                      {!src.isDefault && (
                        <Tooltip title="Remove source">
                          <IconButton
                            size="small"
                            onClick={() => removeMutation.mutate(src.url)}
                            disabled={removeMutation.isPending}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {sources.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Typography variant="body2" color="text.secondary" py={2}>
                        No catalog sources configured.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <AddSourceDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </Stack>
  );
}

// ---- Installed tab ---------------------------------------------------------

function InstalledTab({
  data,
  onSelect,
}: {
  data: InstalledResponse | undefined;
  onSelect: (entry: StoreCatalogEntry) => void;
}) {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const showToast = useAdminToast();

  const updateMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${apiUrl}/api/admin/store/update/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: (d) => {
      showToast(`Update job queued (${d.jobId})`);
      qc.invalidateQueries({ queryKey: ["store-installed"] });
    },
    onError: (e) => showToast(String(e), "error"),
  });

  if (!data?.integrations.length) {
    return (
      <Box py={8} textAlign="center">
        <Typography color="text.secondary">No community integrations installed.</Typography>
        <Typography variant="caption" color="text.secondary">
          Browse the catalog to install your first community integration.
        </Typography>
      </Box>
    );
  }

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Integration</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>Version</TableCell>
            <TableCell>Installed</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.integrations.map((inst) => (
            <TableRow key={inst.id} hover>
              <TableCell>
                <Stack direction="row" alignItems="center" gap={1}>
                  {inst.catalogEntry ? (
                    <Button
                      size="small"
                      variant="text"
                      sx={{ p: 0, fontWeight: 600, textAlign: "left" }}
                      onClick={() => inst.catalogEntry && onSelect(inst.catalogEntry)}
                    >
                      {inst.catalogEntry.name}
                    </Button>
                  ) : (
                    <Typography variant="body2" fontWeight={600}>
                      {inst.id}
                    </Typography>
                  )}
                  {inst.hasUpdate && (
                    <Chip
                      label="Update"
                      color="warning"
                      size="small"
                      icon={<SystemUpdateAltIcon sx={{ fontSize: "0.75rem !important" }} />}
                    />
                  )}
                </Stack>
                {inst.catalogEntry && (
                  <Stack direction="row" gap={0.5} mt={0.5} flexWrap="wrap">
                    {inst.catalogEntry.domains.map((d) => (
                      <DomainChip key={d} domain={d} />
                    ))}
                  </Stack>
                )}
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                  {inst.sourceType}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" fontFamily="monospace">
                  {inst.installedVersion}
                </Typography>
                {inst.hasUpdate && inst.catalogEntry && (
                  <Typography variant="caption" color="warning.main">
                    → {inst.catalogEntry.version}
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {new Date(inst.installedAt).toLocaleDateString()}
                </Typography>
              </TableCell>
              <TableCell align="right">
                {inst.hasUpdate && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="warning"
                    onClick={() => updateMutation.mutate(inst.id)}
                    disabled={updateMutation.isPending}
                  >
                    Update
                  </Button>
                )}
                {!inst.hasUpdate && (
                  <Tooltip title="Up to date">
                    <CheckCircleOutlineIcon sx={{ color: "success.main", fontSize: "1.1rem" }} />
                  </Tooltip>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ---- Main page -------------------------------------------------------------

export function StorePage() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const [mainTab, setMainTab] = useState(0);
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState("");
  const [quality, setQuality] = useState("");
  const [sort, setSort] = useState<"az" | "newest" | "updated">("az");
  const [selectedEntry, setSelectedEntry] = useState<StoreCatalogEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [installUrlOpen, setInstallUrlOpen] = useState(false);
  const showToast = useAdminToast();

  const catalogQuery = useQuery<CatalogResponse>({
    queryKey: ["store-catalog", search, domain, quality, sort],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (domain) params.set("domain", domain);
      if (quality) params.set("quality", quality);
      params.set("sort", sort);
      const res = await fetch(`${apiUrl}/api/admin/store/catalog?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load catalog");
      return res.json();
    },
    staleTime: 60_000,
  });

  const installedQuery = useQuery<InstalledResponse>({
    queryKey: ["store-installed"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/installed`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load installed");
      return res.json();
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/refresh-catalog`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Refresh failed");
      return res.json() as Promise<{ entries: number }>;
    },
    onSuccess: (d) => {
      showToast(`Catalog refreshed — ${d.entries} entries loaded`);
      qc.invalidateQueries({ queryKey: ["store-catalog"] });
    },
    onError: (e) => showToast(String(e), "error"),
  });

  const installedCount = installedQuery.data?.integrations.length ?? 0;
  const updateCount = installedQuery.data?.integrations.filter((i) => i.hasUpdate).length ?? 0;

  const handleSelect = (entry: StoreCatalogEntry) => {
    setSelectedEntry(entry);
    setDrawerOpen(true);
  };

  const handleInstall = (entry: StoreCatalogEntry) => {
    setSelectedEntry(entry);
    setDrawerOpen(true);
  };

  return (
    <Box>
      {/* Page header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        mb={3}
        flexWrap="wrap"
        gap={1}
      >
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Community Store
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Browse, install, and manage community integrations
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            size="small"
          >
            {refreshMutation.isPending ? "Refreshing…" : "Refresh Catalog"}
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setInstallUrlOpen(true)}
            size="small"
          >
            Install from URL
          </Button>
        </Stack>
      </Stack>

      {/* Tabs: Browse / Installed */}
      <Tabs
        value={mainTab}
        onChange={(_, v) => setMainTab(v as number)}
        sx={{ borderBottom: "1px solid", borderColor: "divider", mb: 2 }}
      >
        <Tab label="Browse" />
        <Tab
          label={
            <Stack direction="row" alignItems="center" gap={0.75}>
              Installed
              {installedCount > 0 && (
                <Chip label={installedCount} size="small" sx={{ height: 18, fontSize: "0.7rem" }} />
              )}
              {updateCount > 0 && (
                <Chip
                  label={`${updateCount} update${updateCount > 1 ? "s" : ""}`}
                  size="small"
                  color="warning"
                  sx={{ height: 18, fontSize: "0.7rem" }}
                />
              )}
            </Stack>
          }
        />
        <Tab label="Sources" />
      </Tabs>

      {/* Browse tab */}
      {mainTab === 0 && (
        <>
          {/* Filters */}
          <Stack direction="row" gap={1.5} mb={2} flexWrap="wrap" alignItems="center">
            <TextField
              placeholder="Search integrations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="small"
              sx={{ width: 260 }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <Select value={domain} onChange={(e) => setDomain(e.target.value)} displayEmpty>
                {DOMAIN_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select value={quality} onChange={(e) => setQuality(e.target.value)} displayEmpty>
                {QUALITY_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
                displayEmpty
              >
                {SORT_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {catalogQuery.data && (
              <Typography variant="caption" color="text.secondary" ml="auto">
                {catalogQuery.data.total} integration{catalogQuery.data.total !== 1 ? "s" : ""}
              </Typography>
            )}
          </Stack>

          {catalogQuery.isLoading && (
            <Box display="flex" justifyContent="center" py={8}>
              <CircularProgress />
            </Box>
          )}

          {catalogQuery.isError && (
            <Alert severity="error">
              Failed to load catalog. The community registry may be unavailable — try refreshing.
            </Alert>
          )}

          {catalogQuery.data?.entries.length === 0 && !catalogQuery.isLoading && (
            <Box py={8} textAlign="center">
              <Typography color="text.secondary">No integrations found.</Typography>
              {(search || domain || quality) && (
                <Button
                  size="small"
                  sx={{ mt: 1 }}
                  onClick={() => {
                    setSearch("");
                    setDomain("");
                    setQuality("");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </Box>
          )}

          {catalogQuery.data && catalogQuery.data.entries.length > 0 && (
            <Grid container spacing={2}>
              {catalogQuery.data.entries.map((entry) => (
                <Grid key={entry.id} size={{ xs: 12, sm: 6, lg: 4 }}>
                  <StoreCard entry={entry} onSelect={handleSelect} onInstall={handleInstall} />
                </Grid>
              ))}
            </Grid>
          )}
        </>
      )}

      {/* Installed tab */}
      {mainTab === 1 && (
        <>
          {installedQuery.isLoading && (
            <Box display="flex" justifyContent="center" py={8}>
              <CircularProgress />
            </Box>
          )}
          {installedQuery.isError && (
            <Alert severity="error">Failed to load installed integrations.</Alert>
          )}
          {!installedQuery.isLoading && (
            <InstalledTab data={installedQuery.data} onSelect={handleSelect} />
          )}
        </>
      )}

      {/* Sources tab */}
      {mainTab === 2 && <SourcesTab />}

      {/* Detail drawer */}
      <StoreDetailDrawer
        entry={selectedEntry}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      {/* Install from URL dialog */}
      <InstallFromUrlDialog
        open={installUrlOpen}
        onClose={() => setInstallUrlOpen(false)}
        onSuccess={(jobId) =>
          showToast(`Install job queued (${jobId}). Check Activity for progress.`)
        }
      />
    </Box>
  );
}

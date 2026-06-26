"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ServicesIcon from "@mui/icons-material/Dns";
import ExtensionIcon from "@mui/icons-material/Extension";
import LinkIcon from "@mui/icons-material/Link";
import RefreshIcon from "@mui/icons-material/Refresh";
import SecurityIcon from "@mui/icons-material/Security";
import StarIcon from "@mui/icons-material/Star";
import VerifiedIcon from "@mui/icons-material/Verified";
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
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
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
import { useState } from "react";
import {
  type ExtensionCatalogView,
  type ExtensionSecurityRating,
  useAddExtensionSource,
  useExtensionCatalog,
  useExtensionSources,
  useInstallExtension,
  useInstalledExtensions,
  useRefreshExtensionCatalog,
  useRemoveExtension,
  useRemoveExtensionSource,
  useUpdateExtension,
} from "@/hooks/useExtensions";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useClientPagination } from "../shared/tableHooks";

type Trust = "built-in" | "verified" | "community";

function TrustChip({ trust }: { trust?: Trust }) {
  if (trust === "built-in")
    return <Chip size="small" label="Built-in" color="default" variant="outlined" />;
  if (trust === "verified")
    return <Chip size="small" icon={<VerifiedIcon />} label="Verified" color="success" />;
  return <Chip size="small" label="Community" color="warning" variant="outlined" />;
}

function ComponentChips({ services, integrations }: { services: number; integrations: number }) {
  return (
    <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
      {services > 0 && (
        <Chip
          size="small"
          icon={<ServicesIcon />}
          label={`${services} service${services > 1 ? "s" : ""}`}
          variant="outlined"
        />
      )}
      {integrations > 0 && (
        <Chip
          size="small"
          icon={<ExtensionIcon />}
          label={`${integrations} integration${integrations > 1 ? "s" : ""}`}
          variant="outlined"
        />
      )}
    </Stack>
  );
}

function ratingColor(score: number): "success" | "warning" | "error" {
  if (score >= 6) return "success";
  if (score >= 4) return "warning";
  return "error";
}

function SecurityChip({ rating }: { rating: ExtensionSecurityRating }) {
  return (
    <Tooltip title={rating.factors.join(" · ") || "No special privileges"}>
      <Chip
        size="small"
        icon={<SecurityIcon />}
        label={`Security ${rating.score}/8`}
        color={ratingColor(rating.score)}
        variant="outlined"
      />
    </Tooltip>
  );
}

function BrowseTab() {
  const showToast = useAdminToast();
  const [q, setQ] = useState("");
  const [trust, setTrust] = useState("");
  const [type, setType] = useState("");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");

  const { data, isLoading, isError } = useExtensionCatalog({ q, trust, type });
  const refresh = useRefreshExtensionCatalog();
  const install = useInstallExtension();

  const doInstall = (entry: ExtensionCatalogView) => {
    install.mutate(
      { id: entry.id },
      {
        onSuccess: () => showToast(`Installing ${entry.name}…`, "info"),
        onError: (e) => showToast((e as Error).message, "error"),
      },
    );
  };

  const entries = data?.entries ?? [];

  return (
    <Stack sx={{ gap: 2 }}>
      <TableToolbar>
        <TableSearchField value={q} onChange={setQ} placeholder="Search extensions…" />
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Trust</InputLabel>
          <Select label="Trust" value={trust} onChange={(e) => setTrust(e.target.value)}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="verified">Verified</MenuItem>
            <MenuItem value="community">Community</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 130 }}>
          <InputLabel>Type</InputLabel>
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="service">Services</MenuItem>
            <MenuItem value="integration">Integrations</MenuItem>
          </Select>
        </FormControl>
        <Box sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          startIcon={<LinkIcon />}
          onClick={() => setManifestOpen(true)}
          variant="outlined"
        >
          Install from URL
        </Button>
        <Tooltip title="Refresh catalog">
          <IconButton
            size="small"
            onClick={() =>
              refresh.mutate(undefined, {
                onSuccess: (r) => showToast(`Catalog refreshed (${r.entries} entries)`),
                onError: (e) => showToast((e as Error).message, "error"),
              })
            }
            disabled={refresh.isPending}
          >
            {refresh.isPending ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </TableToolbar>

      {isLoading && (
        <Box sx={{ textAlign: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {isError && <Alert severity="error">Failed to load the extension catalog.</Alert>}
      {!isLoading && !isError && entries.length === 0 && (
        <Alert severity="info">
          No extensions found. Add a catalog source under the Sources tab, or install directly from
          an <code>extension.json</code> URL.
        </Alert>
      )}

      <Grid container spacing={2}>
        {entries.map((e) => (
          <Grid key={e.id} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card
              variant="outlined"
              sx={{ height: "100%", display: "flex", flexDirection: "column" }}
            >
              <CardContent sx={{ flexGrow: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
                    {e.name}
                  </Typography>
                  {e.featured && (
                    <Tooltip title="Featured">
                      <StarIcon fontSize="small" color="warning" />
                    </Tooltip>
                  )}
                  <TrustChip trust={e.trust} />
                </Stack>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  v{e.version}
                  {e.author ? ` · ${e.author}` : ""}
                </Typography>
                {e.summary && (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {e.summary}
                  </Typography>
                )}
                <ComponentChips
                  services={e.components.services}
                  integrations={e.components.integrations}
                />
                {e.removed && <Alert severity="error">Delisted: {e.removed}</Alert>}
                {e.critical && (
                  <Alert severity="error">Security advisory: {e.critical.reason}</Alert>
                )}
                {!e.compatible && (
                  <Alert severity="warning">
                    Requires platform ≥ {e.minPlatform} (this is {e.platformVersion})
                  </Alert>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Box>
                  {e.installed ? (
                    <Button size="small" disabled variant="outlined" fullWidth>
                      Installed{e.hasUpdate ? " · update available" : ""}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="contained"
                      fullWidth
                      disabled={!e.compatible || !!e.removed || !!e.critical || install.isPending}
                      onClick={() => doInstall(e)}
                    >
                      Install
                    </Button>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Dialog open={manifestOpen} onClose={() => setManifestOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Install from extension.json URL</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Direct installs are treated as <strong>community</strong> (unreviewed). Only install
            from sources you trust.
          </Alert>
          <TextField
            autoFocus
            fullWidth
            label="extension.json URL"
            value={manifestUrl}
            onChange={(e) => setManifestUrl(e.target.value)}
            placeholder="https://…/extension.json"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManifestOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!manifestUrl.trim() || install.isPending}
            onClick={() =>
              install.mutate(
                { manifestUrl: manifestUrl.trim() },
                {
                  onSuccess: () => {
                    showToast("Installing extension…", "info");
                    setManifestOpen(false);
                    setManifestUrl("");
                  },
                  onError: (e) => showToast((e as Error).message, "error"),
                },
              )
            }
          >
            Install
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function InstalledTab() {
  const showToast = useAdminToast();
  const { data, isLoading } = useInstalledExtensions();
  const update = useUpdateExtension();
  const remove = useRemoveExtension();
  const rows = data?.extensions ?? [];
  const { paged, paginationProps } = useClientPagination(rows, 25);

  if (isLoading)
    return (
      <Box sx={{ textAlign: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  if (rows.length === 0)
    return (
      <Alert severity="info">No extensions installed yet. Browse the catalog to add one.</Alert>
    );

  return (
    <Stack sx={{ gap: 1 }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Extension</TableCell>
              <TableCell>Trust</TableCell>
              <TableCell>Version</TableCell>
              <TableCell>Components</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paged.map((ext) => (
              <TableRow key={ext.id} hover>
                <TableCell>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {ext.name}
                  </Typography>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {ext.id}
                  </Typography>
                </TableCell>
                <TableCell>
                  <TrustChip trust={ext.sourceTrust as Trust} />
                </TableCell>
                <TableCell>
                  {ext.installedVersion}
                  {ext.hasUpdate && (
                    <Chip
                      size="small"
                      color="info"
                      label={`→ ${ext.latestVersion}`}
                      sx={{ ml: 1 }}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <Stack sx={{ gap: 0.5 }}>
                    {ext.components.map((c) => (
                      <Stack
                        key={`${c.kind}:${c.componentId}`}
                        direction="row"
                        sx={{ gap: 0.5, alignItems: "center" }}
                      >
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={c.kind === "service" ? <ServicesIcon /> : <ExtensionIcon />}
                          label={c.componentId}
                        />
                        {c.securityRating && <SecurityChip rating={c.securityRating} />}
                      </Stack>
                    ))}
                  </Stack>
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" sx={{ gap: 0.5, justifyContent: "flex-end" }}>
                    {ext.hasUpdate && (
                      <Button
                        size="small"
                        onClick={() =>
                          update.mutate(ext.id, {
                            onSuccess: () => showToast(`Updating ${ext.name}…`, "info"),
                            onError: (e) => showToast((e as Error).message, "error"),
                          })
                        }
                      >
                        Update
                      </Button>
                    )}
                    <Tooltip title="Uninstall">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => {
                          if (
                            !confirm(
                              `Uninstall ${ext.name}? This removes its services and integrations.`,
                            )
                          )
                            return;
                          remove.mutate(ext.id, {
                            onSuccess: () => showToast(`Removing ${ext.name}…`, "info"),
                            onError: (e) => showToast((e as Error).message, "error"),
                          });
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <AdminTablePagination {...paginationProps} count={rows.length} />
    </Stack>
  );
}

function SourcesTab() {
  const showToast = useAdminToast();
  const { data, isLoading } = useExtensionSources();
  const add = useAddExtensionSource();
  const remove = useRemoveExtensionSource();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const sources = data?.sources ?? [];

  return (
    <Stack sx={{ gap: 1 }}>
      <Stack direction="row" sx={{ justifyContent: "flex-end" }}>
        <Button
          size="small"
          startIcon={<AddIcon />}
          variant="outlined"
          onClick={() => setOpen(true)}
        >
          Add source
        </Button>
      </Stack>
      {isLoading ? (
        <Box sx={{ textAlign: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell>
                <TableCell>URL</TableCell>
                <TableCell>Trust</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.url} hover>
                  <TableCell>{s.label}</TableCell>
                  <TableCell sx={{ wordBreak: "break-all" }}>{s.url}</TableCell>
                  <TableCell>
                    {s.isDefault ? (
                      <Chip
                        size="small"
                        icon={<VerifiedIcon />}
                        color="success"
                        label="Verified (default)"
                      />
                    ) : (
                      <Chip size="small" color="warning" variant="outlined" label="Community" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {!s.isDefault && (
                      <Tooltip title="Remove source">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() =>
                            remove.mutate(s.url, {
                              onSuccess: () => showToast("Source removed"),
                              onError: (e) => showToast((e as Error).message, "error"),
                            })
                          }
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add catalog source</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            Extensions from operator-added sources are surfaced as <strong>community</strong>
            (unreviewed). The default OpenMapX catalog is the only <strong>verified</strong> source.
          </Alert>
          <Stack sx={{ gap: 2, mt: 1 }}>
            <TextField
              label="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              fullWidth
            />
            <TextField
              label="Catalog URL (HTTPS)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/catalog.json"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!url.trim() || !label.trim() || add.isPending}
            onClick={() =>
              add.mutate(
                { url: url.trim(), label: label.trim() },
                {
                  onSuccess: () => {
                    showToast("Source added");
                    setOpen(false);
                    setUrl("");
                    setLabel("");
                  },
                  onError: (e) => showToast((e as Error).message, "error"),
                },
              )
            }
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function ExtensionStorePage() {
  const [tab, setTab] = useState(0);
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title="Extensions"
        subtitle="Browse, install, and manage community extensions — integrations and services."
      />
      <Tabs value={tab} onChange={(_, v) => setTab(v)}>
        <Tab label="Browse" />
        <Tab label="Installed" />
        <Tab label="Sources" />
      </Tabs>
      {tab === 0 && <BrowseTab />}
      {tab === 1 && <InstalledTab />}
      {tab === 2 && <SourcesTab />}
    </Stack>
  );
}

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
import { useState } from "react";
import {
  type ExtensionCatalogView,
  type ExtensionInstallPreview,
  type ExtensionInstallRequest,
  type ExtensionSecurityRating,
  type InstalledExtensionView,
  useAddExtensionSource,
  useExtensionCatalog,
  useExtensionSources,
  useInstallExtension,
  useInstalledExtensions,
  usePreviewExtensionInstall,
  useRefreshExtensionCatalog,
  useRemoveExtension,
  useRemoveExtensionSource,
  useUpdateExtension,
} from "@/hooks/useExtensions";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
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

function effectivePortLabel(
  port: ExtensionInstallPreview["services"][number]["hostPorts"][number],
) {
  const host = port.bindAddress.includes(":") ? `[${port.bindAddress}]` : port.bindAddress;
  return `${host}:${port.host} → container ${port.container}/${port.protocol}`;
}

function ExtensionSecurityPreviewDialog({
  preview,
  busy,
  onClose,
  onConfirm,
}: {
  preview: ExtensionInstallPreview | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const hostPorts = preview?.services.flatMap((service) =>
    service.hostPorts.map((port) => ({ service: service.name, port })),
  );

  return (
    <Dialog open={preview !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Review extension security</DialogTitle>
      <DialogContent>
        {preview && (
          <Stack sx={{ gap: 2, mt: 0.5 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {preview.extension.name} v{preview.extension.version}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                This preview is bound to the resolved manifest and exact repository commits.
              </Typography>
            </Box>

            {hostPorts && hostPorts.length > 0 ? (
              <Alert severity="warning">
                This extension publishes host ports. Confirm these effective bindings before the
                service starts:
                <Box component="ul" sx={{ mb: 0, pl: 2.5 }}>
                  {hostPorts.map(({ service, port }) => (
                    <li
                      key={`${service}:${port.bindAddress}:${port.host}:${port.container}:${port.protocol}`}
                    >
                      {service}: <code>{effectivePortLabel(port)}</code>
                    </li>
                  ))}
                </Box>
              </Alert>
            ) : (
              <Alert severity="success">No host ports will be published.</Alert>
            )}

            {preview.services.length === 0 ? (
              <Typography variant="body2">
                This extension contains no service containers.
              </Typography>
            ) : (
              preview.services.map((service) => (
                <Paper key={service.id} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                    <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                      {service.name} v{service.version}
                    </Typography>
                    <SecurityChip rating={service.securityRating} />
                  </Stack>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    Commit {service.repositoryCommit.slice(0, 12)}
                  </Typography>
                </Paper>
              ))
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" color="warning" onClick={onConfirm} disabled={busy}>
          {preview?.requiresHostPortConfirmation
            ? "Confirm ports and install"
            : "Install extension"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function BrowseTab() {
  const showToast = useAdminToast();
  const [q, setQ] = useState("");
  const [trust, setTrust] = useState("");
  const [type, setType] = useState("");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [pendingInstall, setPendingInstall] = useState<ExtensionInstallRequest | null>(null);
  const [securityPreview, setSecurityPreview] = useState<ExtensionInstallPreview | null>(null);

  const { data, isLoading, isError } = useExtensionCatalog({ q, trust, type });
  const refresh = useRefreshExtensionCatalog();
  const install = useInstallExtension();
  const previewInstall = usePreviewExtensionInstall();

  const doInstall = (entry: ExtensionCatalogView) => {
    const request = { id: entry.id };
    previewInstall.mutate(request, {
      onSuccess: (preview) => {
        setPendingInstall(request);
        setSecurityPreview(preview);
      },
      onError: (e) => showToast((e as Error).message, "error"),
    });
  };

  const confirmInstall = () => {
    if (!pendingInstall || !securityPreview) return;
    install.mutate(
      { ...pendingInstall, hostPortConfirmation: securityPreview.confirmation },
      {
        onSuccess: () => {
          showToast(`Installing ${securityPreview.extension.name}…`, "info");
          setSecurityPreview(null);
          setPendingInstall(null);
          setManifestUrl("");
        },
        onError: (e) => showToast((e as Error).message, "error"),
      },
    );
  };

  const entries = data?.entries ?? [];

  return (
    <Stack sx={{ gap: 2 }}>
      <Paper variant="outlined" sx={{ p: 1.25 }}>
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
              {refresh.isPending ? (
                <CircularProgress size={18} />
              ) : (
                <RefreshIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </TableToolbar>
      </Paper>

      {isLoading && (
        <Box sx={{ textAlign: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {isError && <Alert severity="error">Failed to load the extension catalog.</Alert>}
      {!isLoading && !isError && entries.length === 0 && (
        <Alert severity="info" variant="outlined">
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
                  {[e.version ? `v${e.version}` : null, e.author].filter(Boolean).join(" · ")}
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
                      disabled={
                        !e.compatible ||
                        !!e.removed ||
                        !!e.critical ||
                        install.isPending ||
                        previewInstall.isPending
                      }
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
            disabled={!manifestUrl.trim() || previewInstall.isPending}
            onClick={() => {
              const request = { manifestUrl: manifestUrl.trim() };
              previewInstall.mutate(request, {
                onSuccess: (preview) => {
                  setPendingInstall(request);
                  setSecurityPreview(preview);
                  setManifestOpen(false);
                },
                onError: (e) => showToast((e as Error).message, "error"),
              });
            }}
          >
            Review security
          </Button>
        </DialogActions>
      </Dialog>

      <ExtensionSecurityPreviewDialog
        preview={securityPreview}
        busy={install.isPending}
        onClose={() => {
          setSecurityPreview(null);
          setPendingInstall(null);
        }}
        onConfirm={confirmInstall}
      />
    </Stack>
  );
}

function InstalledTab() {
  const showToast = useAdminToast();
  const { data, isLoading } = useInstalledExtensions();
  const update = useUpdateExtension();
  const previewInstall = usePreviewExtensionInstall();
  const remove = useRemoveExtension();
  const [pendingUpdate, setPendingUpdate] = useState<InstalledExtensionView | null>(null);
  const [securityPreview, setSecurityPreview] = useState<ExtensionInstallPreview | null>(null);
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
      <Alert severity="info" variant="outlined">
        No extensions installed yet. Browse the catalog to add one.
      </Alert>
    );

  return (
    <>
      <AdminTableSurface
        pagination={<AdminTablePagination {...paginationProps} count={rows.length} />}
      >
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
                          disabled={previewInstall.isPending || update.isPending}
                          onClick={() =>
                            previewInstall.mutate(
                              { id: ext.id },
                              {
                                onSuccess: (preview) => {
                                  setPendingUpdate(ext);
                                  setSecurityPreview(preview);
                                },
                                onError: (e) => showToast((e as Error).message, "error"),
                              },
                            )
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
      </AdminTableSurface>
      <ExtensionSecurityPreviewDialog
        preview={securityPreview}
        busy={update.isPending}
        onClose={() => {
          setSecurityPreview(null);
          setPendingUpdate(null);
        }}
        onConfirm={() => {
          if (!pendingUpdate || !securityPreview) return;
          update.mutate(
            {
              id: pendingUpdate.id,
              hostPortConfirmation: securityPreview.confirmation,
            },
            {
              onSuccess: () => {
                showToast(`Updating ${pendingUpdate.name}…`, "info");
                setSecurityPreview(null);
                setPendingUpdate(null);
              },
              onError: (e) => showToast((e as Error).message, "error"),
            },
          );
        }}
      />
    </>
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
    <>
      <AdminTableSurface
        title="Catalog sources"
        description="Trusted indexes used to discover extensions"
        toolbar={
          <Button
            size="small"
            startIcon={<AddIcon />}
            variant="outlined"
            onClick={() => setOpen(true)}
          >
            Add source
          </Button>
        }
      >
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
      </AdminTableSurface>

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
    </>
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
      <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label="Extension management">
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

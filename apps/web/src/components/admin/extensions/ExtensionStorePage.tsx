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
import type {
  AdminExtensionCatalogEntry,
  AdminExtensionInstallPreview,
  AdminExtensionInstallRequest,
  AdminExtensionSecurityRating,
} from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import Dialog from "@/components/ui/Dialog";
import {
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
import { AdminRequestError, adminErrorText } from "@/lib/admin/adminRequestError";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminTab } from "@/lib/admin/useAdminQueryState";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useClientPagination } from "../shared/tableHooks";
import { StandaloneInstallDialog } from "./StandaloneInstallDialog";
import { StandaloneIntegrationsPanel } from "./StandaloneIntegrationsPanel";

type Trust = AdminExtensionInstallPreview["sourceTrust"];

function TrustChip({ trust }: { trust?: Trust }) {
  const t = useTranslations("adminExtensions");
  if (trust === "built-in")
    return <Chip size="small" label={t("builtIn")} color="default" variant="outlined" />;
  if (trust === "verified")
    return <Chip size="small" icon={<VerifiedIcon />} label={t("verified")} color="success" />;
  return <Chip size="small" label={t("community")} color="warning" variant="outlined" />;
}

function ComponentChips({ services, integrations }: { services: number; integrations: number }) {
  const t = useTranslations("adminExtensions");
  return (
    <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
      {services > 0 && (
        <Chip
          size="small"
          icon={<ServicesIcon />}
          label={t("servicesCount", { services })}
          variant="outlined"
        />
      )}
      {integrations > 0 && (
        <Chip
          size="small"
          icon={<ExtensionIcon />}
          label={t("integrationsCount", { integrations })}
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

function SecurityChip({ rating }: { rating: AdminExtensionSecurityRating }) {
  const t = useTranslations("adminExtensions");
  return (
    <Tooltip title={rating.factors.join(" · ") || t("noSpecialPrivileges")}>
      <Chip
        size="small"
        icon={<SecurityIcon />}
        label={t("securityScore", { score: rating.score })}
        color={ratingColor(rating.score)}
        variant="outlined"
      />
    </Tooltip>
  );
}

function effectivePortLabel(
  port: AdminExtensionInstallPreview["services"][number]["hostPorts"][number],
) {
  const host = port.bindAddress.includes(":") ? `[${port.bindAddress}]` : port.bindAddress;
  return `${host}:${port.host} → container ${port.container}/${port.protocol}`;
}

function ExtensionSecurityPreviewDialog({
  preview,
  busy,
  action,
  onClose,
  onConfirm,
}: {
  preview: AdminExtensionInstallPreview | null;
  busy: boolean;
  action: "install" | "update";
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("adminExtensions");
  const tCommon = useTranslations("common");
  const hostPorts = preview?.services.flatMap((service) =>
    service.hostPorts.map((port) => ({ service: service.name, port })),
  );

  return (
    <Dialog open={preview !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("reviewExtensionSecurity")}</DialogTitle>
      <DialogContent>
        {preview && (
          <Stack sx={{ gap: 2, mt: 0.5 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {preview.extension.name} v{preview.extension.version}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {t("thisPreviewIsBoundTo")}
              </Typography>
            </Box>

            {hostPorts && hostPorts.length > 0 ? (
              <Alert severity="warning">
                {t("thisExtensionPublishesHostPorts")}
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
              <Alert severity="success">{t("noHostPortsWillBe")}</Alert>
            )}

            {preview.services.length === 0 ? (
              <Typography variant="body2">{t("thisExtensionContainsNoService")}</Typography>
            ) : (
              preview.services.map((service) => (
                <Paper key={service.id} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                    <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                      {service.name} v{service.version}
                    </Typography>
                    <SecurityChip rating={service.securityRating} />
                  </Stack>
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary", overflowWrap: "anywhere" }}
                  >
                    {t("repositoryCommit", { commit: service.repositoryCommit })}
                  </Typography>
                  <Typography variant="body2">
                    {t("securityFacts", {
                      builtIn: String(service.securityRating.requiresBuiltIn),
                      hostPorts: service.securityRating.hostPorts,
                      secretCount: service.securityRating.secretCount,
                    })}
                  </Typography>
                  <Typography variant="body2">
                    {service.securityRating.deploymentVariables.length
                      ? t("deploymentVariables", {
                          variables: service.securityRating.deploymentVariables.join(", "),
                        })
                      : t("noDeploymentVariables")}
                  </Typography>
                  <Typography variant="body2">
                    {service.securityRating.factors.join(" · ") || t("noSpecialPrivileges")}
                  </Typography>
                </Paper>
              ))
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {tCommon("cancel")}
        </Button>
        <Button variant="contained" color="warning" onClick={onConfirm} disabled={busy}>
          {preview?.requiresHostPortConfirmation
            ? t("confirmPortsAndAction", { action })
            : action === "update"
              ? t("updateExtension")
              : t("installExtension")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** UI sessions retire synchronously, even when a form goes A→B→A before acknowledgement.
 * Domain effects are intentionally owned by mutationFn/the layout, not these callbacks.
 */
function useExtensionUiSession() {
  const t = useTranslations("adminExtensions");
  const binding = useActivityClient();
  const owner = useAdminMutationOwner(binding.client, binding.apiUrl);
  const generation = useRef(0);
  const retire = useCallback(() => {
    generation.current++;
  }, []);
  const capture = useCallback(() => {
    const session = generation.current;
    return () => owner.active && generation.current === session;
  }, [owner]);
  /** The server's own message when it sent one, otherwise the catalogue's wording. */
  const errorText = useCallback(
    (error: unknown, fallback?: string) =>
      adminErrorText(
        error,
        error instanceof AdminRequestError && error.unconfirmed
          ? t("requestUnconfirmed")
          : (fallback ?? t("extensionRequestFailed")),
      ),
    [t],
  );
  return { binding, owner, retire, capture, errorText };
}

function useExtensionPreview(action: "install" | "update", snapshot: unknown) {
  const t = useTranslations("adminExtensions");
  const ui = useExtensionUiSession();
  const preview = usePreviewExtensionInstall(ui.binding);
  const install = useInstallExtension(ui.binding);
  const update = useUpdateExtension(ui.binding);
  const showToast = useAdminToast();
  type Bundle = Readonly<{
    request: Readonly<AdminExtensionInstallRequest>;
    preview: AdminExtensionInstallPreview;
    owner: typeof ui.owner;
    action: typeof action;
    current: () => boolean;
  }>;
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const retire = useCallback(() => {
    ui.retire();
    setBundle(null);
    setPreparing(false);
    setBusy(false);
  }, [ui.retire]);
  const priorSnapshot = useRef(snapshot);
  useLayoutEffect(() => {
    if (priorSnapshot.current !== snapshot) {
      priorSnapshot.current = snapshot;
      retire();
    }
  }, [snapshot, retire]);
  const start = async (input: AdminExtensionInstallRequest) => {
    if (executing.current) return;
    retire();
    const current = ui.capture();
    const request = Object.freeze({ ...input });
    setPreparing(true);
    try {
      const result = await preview.mutateAsync(request);
      if (!current()) return;
      if (request.id && result.extension.id !== request.id)
        throw new Error(t("thePreviewDoesNotMatch"));
      setBundle(Object.freeze({ request, preview: result, owner: ui.owner, action, current }));
    } catch (error) {
      if (current()) showToast(ui.errorText(error, t("extensionPreviewFailed")), "error");
    } finally {
      if (current()) setPreparing(false);
    }
  };
  const confirm = async (onAccepted?: () => void) => {
    const captured = bundle;
    if (!captured || captured.owner !== ui.owner || !captured.current() || executing.current)
      return;
    executing.current = true;
    setBusy(true);
    try {
      if (captured.action === "update") {
        if (!captured.request.id) throw new Error(t("noExtensionSelectedForUpdate"));
        await update.mutateAsync({
          id: captured.request.id,
          hostPortConfirmation: captured.preview.confirmation,
        });
      } else {
        await install.mutateAsync({
          ...captured.request,
          hostPortConfirmation: captured.preview.confirmation,
        });
      }
      if (!captured.current()) return;
      showToast(
        t("actionQueued", { action: captured.action, name: captured.preview.extension.name }),
        "info",
      );
      retire();
      onAccepted?.();
    } catch (error) {
      if (captured.current()) showToast(ui.errorText(error), "error");
    } finally {
      executing.current = false;
      if (captured.current()) setBusy(false);
    }
  };
  return {
    start,
    confirm,
    retire,
    preparing,
    busy,
    preview: bundle?.owner === ui.owner ? bundle.preview : null,
    capture: ui.capture,
    errorText: ui.errorText,
  };
}

function BrowseTab() {
  const t = useTranslations("adminExtensions");
  const tCommon = useTranslations("common");
  const showToast = useAdminToast();
  const [q, setQ] = useState("");
  const [trust, setTrust] = useState("");
  const [type, setType] = useState("");
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const { data, isLoading, isError } = useExtensionCatalog({ q, trust, type });
  const flow = useExtensionPreview("install", data);
  const refresh = useRefreshExtensionCatalog();
  const doInstall = (entry: AdminExtensionCatalogEntry) => {
    void flow.start({ id: entry.id });
  };
  const closeManifest = () => {
    flow.retire();
    setManifestOpen(false);
  };

  const entries = data?.entries ?? [];

  return (
    <Stack sx={{ gap: 2 }}>
      <Paper variant="outlined" sx={{ p: 1.25 }}>
        <TableToolbar>
          <TableSearchField
            value={q}
            onChange={(value) => {
              flow.retire();
              setQ(value);
            }}
            placeholder={t("searchExtensions")}
          />
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>{t("trust")}</InputLabel>
            <Select
              label={t("trust")}
              value={trust}
              onChange={(e) => {
                flow.retire();
                setTrust(e.target.value);
              }}
            >
              <MenuItem value="">{t("all")}</MenuItem>
              <MenuItem value="verified">{t("verified")}</MenuItem>
              <MenuItem value="community">{t("community")}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>{t("type")}</InputLabel>
            <Select
              label={t("type")}
              value={type}
              onChange={(e) => {
                flow.retire();
                setType(e.target.value);
              }}
            >
              <MenuItem value="">{t("all")}</MenuItem>
              <MenuItem value="service">{t("services")}</MenuItem>
              <MenuItem value="integration">{t("integrations")}</MenuItem>
            </Select>
          </FormControl>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            startIcon={<LinkIcon />}
            onClick={() => {
              flow.retire();
              setManifestOpen(true);
            }}
            variant="outlined"
          >
            {t("installFromUrl")}
          </Button>
          <Tooltip title={t("refreshCatalog")}>
            <IconButton
              size="small"
              onClick={() => {
                flow.retire();
                const current = flow.capture();
                void refresh.mutateAsync().then(
                  (r) => {
                    if (current()) showToast(t("catalogRefreshed", { count: r.entries }));
                  },
                  (error) => {
                    if (current()) showToast(flow.errorText(error), "error");
                  },
                );
              }}
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
      {isError && <Alert severity="error">{t("failedToLoadTheExtension")}</Alert>}
      {data?.revocationDataStale && (
        <Alert severity="warning">{t("revocationDataIsStaleCurrent")}</Alert>
      )}
      {!isLoading && !isError && entries.length === 0 && (
        <Alert severity="info" variant="outlined">
          {t.rich("noExtensionsFound", {
            file: "extension.json",
            code: (chunks) => <code>{chunks}</code>,
          })}
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
                    <Tooltip title={t("featured")}>
                      <StarIcon fontSize="small" color="warning" />
                    </Tooltip>
                  )}
                  <TrustChip trust={e.trust} />
                </Stack>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {[e.version ? `v${e.version}` : t("versionUnknown"), e.author]
                    .filter(Boolean)
                    .join(" · ")}
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
                {e.status === "revoked" && <Alert severity="error">{t("revoked")}</Alert>}
                {e.status === "stale-revocation-data" && (
                  <Alert severity="warning">{t("securityStatusStaleRevocationData")}</Alert>
                )}
                {e.removed && (
                  <Alert severity="error">{t("delistedRemoved", { removed: e.removed })}</Alert>
                )}
                {e.critical && (
                  <Alert severity="error">
                    {t("securityAdvisoryReason", { reason: e.critical.reason })}
                  </Alert>
                )}
                {!e.compatible && (
                  <Alert severity="warning">
                    {t("requiresPlatform", {
                      minPlatform: e.minPlatform ?? "",
                      platformVersion: e.platformVersion,
                    })}
                  </Alert>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Box>
                  {e.installed ? (
                    <Button size="small" disabled variant="outlined" fullWidth>
                      {e.hasUpdate ? t("installedUpdateAvailable") : t("installed")}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="contained"
                      fullWidth
                      disabled={
                        !e.compatible || !!e.removed || !!e.critical || flow.busy || flow.preparing
                      }
                      onClick={() => doInstall(e)}
                    >
                      {t("install")}
                    </Button>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Dialog open={manifestOpen && !flow.preview} onClose={closeManifest} fullWidth maxWidth="sm">
        <DialogTitle>{t("installFromExtensionJsonUrl")}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t.rich("directInstallTrust", { strong: (chunks) => <strong>{chunks}</strong> })}
          </Alert>
          <TextField
            autoFocus
            fullWidth
            label={t("extensionJsonUrl")}
            value={manifestUrl}
            onChange={(e) => {
              flow.retire();
              setManifestUrl(e.target.value);
            }}
            placeholder="https://…/extension.json"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeManifest}>{tCommon("cancel")}</Button>
          <Button
            variant="contained"
            disabled={!manifestUrl.trim() || flow.preparing}
            onClick={() => {
              void flow.start({ manifestUrl: manifestUrl.trim() });
            }}
          >
            {t("reviewSecurity")}
          </Button>
        </DialogActions>
      </Dialog>

      <ExtensionSecurityPreviewDialog
        preview={flow.preview}
        action="install"
        busy={flow.busy}
        onClose={flow.retire}
        onConfirm={() => {
          void flow.confirm(() => {
            setManifestUrl("");
            setManifestOpen(false);
          });
        }}
      />
    </Stack>
  );
}

function InstalledTab() {
  const t = useTranslations("adminExtensions");
  const showToast = useAdminToast();
  const { data, isLoading, isError } = useInstalledExtensions();
  const flow = useExtensionPreview("update", isError ? null : data);
  const remove = useRemoveExtension();
  const rows = data?.extensions ?? [];
  const { paged, paginationProps } = useClientPagination(rows, 25);

  if (isLoading)
    return (
      <Box sx={{ textAlign: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  if (isError && !data)
    return <Alert severity="error">{t("failedToLoadInstalledExtensions")}</Alert>;
  if (!isError && rows.length === 0)
    return (
      <Alert severity="info" variant="outlined">
        {t("noExtensionsInstalledYetBrowse")}
      </Alert>
    );

  return (
    <>
      {isError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t("failedToRefreshInstalledExtensions")}
        </Alert>
      )}
      <AdminTableSurface
        pagination={<AdminTablePagination {...paginationProps} count={rows.length} />}
      >
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("extension")}</TableCell>
                <TableCell>{t("trust")}</TableCell>
                <TableCell>{t("versionColumn")}</TableCell>
                <TableCell>{t("components")}</TableCell>
                <TableCell align="right">{t("actions")}</TableCell>
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
                    <TrustChip trust={ext.sourceTrust} />
                  </TableCell>
                  <TableCell>
                    {ext.installedVersion}
                    {(isError || ext.hasUpdate === null) && (
                      <Typography variant="caption" component="div" color="text.secondary">
                        {t("updateStatusUnavailable")}
                      </Typography>
                    )}
                    {!isError && ext.hasUpdate === true && (
                      <Chip
                        size="small"
                        color="info"
                        label={t("latestVersion", { latestVersion: ext.latestVersion ?? "" })}
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
                      {!isError && ext.hasUpdate === true && (
                        <Button
                          size="small"
                          disabled={flow.preparing || flow.busy || remove.isPendingFor(ext.id)}
                          onClick={() => {
                            void flow.start({ id: ext.id });
                          }}
                        >
                          {t("update")}
                        </Button>
                      )}
                      <Tooltip title={t("uninstall")}>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={remove.isPendingFor(ext.id) || flow.busy}
                          onClick={() => {
                            if (remove.isPendingFor(ext.id)) return;
                            flow.retire();
                            const current = flow.capture();
                            if (!confirm(t("uninstallNameThisRemovesIts", { name: ext.name })))
                              return;
                            void remove.mutateAsync(ext.id).then(
                              () => {
                                if (current())
                                  showToast(
                                    t("removalQueuedForNameCheck", { name: ext.name }),
                                    "info",
                                  );
                              },
                              (error) => {
                                if (current()) showToast(flow.errorText(error), "error");
                              },
                            );
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
        preview={flow.preview}
        action="update"
        busy={flow.busy}
        onClose={flow.retire}
        onConfirm={() => {
          void flow.confirm();
        }}
      />
    </>
  );
}

function SourcesTab() {
  const t = useTranslations("adminExtensions");
  const tCommon = useTranslations("common");
  const showToast = useAdminToast();
  const { data, isLoading, isError } = useExtensionSources();
  const ui = useExtensionUiSession();
  const adding = useRef(false);
  const add = useAddExtensionSource();
  const remove = useRemoveExtensionSource();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const sources = data?.sources ?? [];

  return (
    <>
      <AdminTableSurface
        title={t("catalogSources")}
        description={t("catalogIndexesUsedToDiscover")}
        toolbar={
          <Button
            size="small"
            startIcon={<AddIcon />}
            variant="outlined"
            onClick={() => {
              ui.retire();
              setOpen(true);
            }}
          >
            {t("addSource")}
          </Button>
        }
      >
        {isLoading ? (
          <Box sx={{ textAlign: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        ) : isError ? (
          <Alert severity="error">{t("failedToLoadExtensionSources")}</Alert>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("label")}</TableCell>
                  <TableCell>{t("urlColumn")}</TableCell>
                  <TableCell>{t("trust")}</TableCell>
                  <TableCell align="right">{t("actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map((s) => (
                  <TableRow key={s.url} hover>
                    <TableCell>{s.label}</TableCell>
                    <TableCell sx={{ wordBreak: "break-all" }}>{s.url}</TableCell>
                    <TableCell>
                      {s.isDefault ? (
                        <Chip size="small" label={t("defaultCatalog")} />
                      ) : (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={t("community")}
                        />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {!s.isDefault && (
                        <Tooltip title={t("removeSource")}>
                          <IconButton
                            size="small"
                            color="error"
                            disabled={remove.isPendingFor(s.url)}
                            onClick={() => {
                              if (remove.isPendingFor(s.url)) return;
                              const current = ui.capture();
                              void remove.mutateAsync(s.url).then(
                                () => {
                                  if (current()) showToast(t("sourceRemoved"));
                                },
                                (error) => {
                                  if (current()) showToast(ui.errorText(error), "error");
                                },
                              );
                            }}
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

      <Dialog
        open={open}
        onClose={() => {
          ui.retire();
          setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t("addCatalogSource")}</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            {t.rich("operatorSourceTrust", { strong: (chunks) => <strong>{chunks}</strong> })}
          </Alert>
          <Stack sx={{ gap: 2, mt: 1 }}>
            <TextField
              label={t("label")}
              value={label}
              onChange={(e) => {
                ui.retire();
                setLabel(e.target.value);
              }}
              fullWidth
            />
            <TextField
              label={t("catalogUrlHttps")}
              value={url}
              onChange={(e) => {
                ui.retire();
                setUrl(e.target.value);
              }}
              placeholder="https://…/catalog.json"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              ui.retire();
              setOpen(false);
            }}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={!url.trim() || !label.trim() || add.isPending}
            onClick={() => {
              if (adding.current) return;
              adding.current = true;
              const current = ui.capture();
              void add
                .mutateAsync({ url: url.trim(), label: label.trim() })
                .then(
                  () => {
                    if (!current()) return;
                    showToast(t("sourceAdded"));
                    ui.retire();
                    setOpen(false);
                    setUrl("");
                    setLabel("");
                  },
                  (error) => {
                    if (current()) showToast(ui.errorText(error), "error");
                  },
                )
                .finally(() => {
                  adding.current = false;
                });
            }}
          >
            {t("add")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function ExtensionStoreContent() {
  const t = useTranslations("adminExtensions");
  const [tab, setTab] = useAdminTab(["browse", "installed", "sources", "local"]);
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title={t("extensions")} subtitle={t("browseInstallAndManageCommunity")} />
      <Box>
        <StandaloneInstallDialog />
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label={t("extensionManagement")}>
        <Tab id="extensions-tab-0" aria-controls="extensions-panel-0" label={t("browse")} />
        <Tab id="extensions-tab-1" aria-controls="extensions-panel-1" label={t("installed")} />
        <Tab id="extensions-tab-2" aria-controls="extensions-panel-2" label={t("sources")} />
        <Tab
          id="extensions-tab-3"
          aria-controls="extensions-panel-3"
          label={t("localIntegrations")}
        />
      </Tabs>
      <div role="tabpanel" id={`extensions-panel-${tab}`} aria-labelledby={`extensions-tab-${tab}`}>
        {tab === 0 && <BrowseTab />}
        {tab === 1 && <InstalledTab />}
        {tab === 2 && <SourcesTab />}
        {tab === 3 && <StandaloneIntegrationsPanel />}
      </div>
    </Stack>
  );
}

/** Replacing a configured origin retires every tab/dialog, including origin A→B→A. */
export function ExtensionStorePage() {
  const { apiUrl } = useActivityClient();
  return <ExtensionStoreContent key={apiUrl} />;
}

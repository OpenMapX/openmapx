"use client";

import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { DomainChip } from "../integrations/DomainChip";
import { StatusBadge } from "../integrations/StatusBadge";
import type { StoreCatalogEntry } from "./StoreCard";
import { TrustDisclosure, type TrustProfile } from "./TrustDisclosure";

interface DetailResponse extends StoreCatalogEntry {
  readme: string | null;
  installedAt: string | null;
}

interface StoreDetailDrawerProps {
  entry: StoreCatalogEntry | null;
  open: boolean;
  onClose: () => void;
}

/** Derive trust profile from catalog entry. Conservative: assume yes when unknown. */
function inferCatalogTrust(entry: StoreCatalogEntry): TrustProfile {
  const serviceHeavyDomains = ["routing", "transit", "geocoding", "tiles"];
  const hasServiceDomain = entry.domains.some((d) => serviceHeavyDomains.includes(d));
  return {
    frontendBundle: entry.tags.includes("frontend") || entry.tags.includes("overlay"),
    backendCode: true,
    externalNetwork: true,
    secretUsage:
      entry.tags.includes("api-key") ||
      entry.tags.includes("credentials") ||
      entry.domains.some((d) => ["data-source", "photos", "street-view", "overlay"].includes(d)),
    serviceRequirements: hasServiceDomain ? ["May require Docker services"] : [],
  };
}

function ReadmePanel({ text }: { text: string }) {
  return (
    <Box
      component="pre"
      sx={{
        fontFamily: "monospace",
        fontSize: "0.78rem",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        m: 0,
        p: 2,
        bgcolor: "action.hover",
        borderRadius: 1,
        maxHeight: 400,
        overflowY: "auto",
        lineHeight: 1.6,
      }}
    >
      {text}
    </Box>
  );
}

export function StoreDetailDrawer({ entry, open, onClose }: StoreDetailDrawerProps) {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const [tab, setTab] = useState(0);
  const [toast, setToast] = useState<{ msg: string; severity: "success" | "error" } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Reset tab when switching entries
  useEffect(() => {
    setTab(0);
  }, []);

  const { data: detail, isLoading } = useQuery<DetailResponse>({
    queryKey: ["store-entry-detail", entry?.id],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/catalog/${entry?.id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: open && !!entry,
  });

  const installMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/install`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: entry?.repository, version: entry?.version }),
      });
      if (!res.ok) throw new Error("Install failed");
      return res.json();
    },
    onSuccess: (data) => {
      setToast({ msg: `Install job queued (job ${data.jobId}).`, severity: "success" });
      qc.invalidateQueries({ queryKey: ["store-catalog"] });
      qc.invalidateQueries({ queryKey: ["store-installed"] });
    },
    onError: (err) => setToast({ msg: String(err), severity: "error" }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/update/${entry?.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json();
    },
    onSuccess: (data) => {
      setToast({ msg: `Update job queued (job ${data.jobId}).`, severity: "success" });
      qc.invalidateQueries({ queryKey: ["store-catalog"] });
      qc.invalidateQueries({ queryKey: ["store-installed"] });
    },
    onError: (err) => setToast({ msg: String(err), severity: "error" }),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/${entry?.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Remove failed");
      return res.json();
    },
    onSuccess: (data) => {
      setToast({ msg: `Removal job queued (job ${data.jobId}).`, severity: "success" });
      setConfirmRemove(false);
      qc.invalidateQueries({ queryKey: ["store-catalog"] });
      qc.invalidateQueries({ queryKey: ["store-installed"] });
      onClose();
    },
    onError: (err) => setToast({ msg: String(err), severity: "error" }),
  });

  const busy = installMutation.isPending || updateMutation.isPending || removeMutation.isPending;
  const d = detail ?? entry;

  return (
    <>
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        PaperProps={{ sx: { width: { xs: "100vw", sm: 520 } } }}
      >
        {/* Header */}
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            p: 2,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Box flex={1} mr={1}>
            <Stack direction="row" alignItems="center" gap={1} mb={0.25} flexWrap="wrap">
              <Typography variant="h6" fontWeight={700} lineHeight={1.3}>
                {d?.name ?? "Loading..."}
              </Typography>
              {d?.quality && <StatusBadge quality={d.quality} />}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              by {d?.author} · v{d?.version}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>

        {isLoading && (
          <Box display="flex" justifyContent="center" p={4}>
            <CircularProgress size={32} />
          </Box>
        )}

        {d && !isLoading && (
          <>
            <Tabs
              value={tab}
              onChange={(_, v) => setTab(v as number)}
              sx={{ borderBottom: "1px solid", borderColor: "divider", px: 2 }}
            >
              <Tab label="Overview" />
              <Tab label="Trust & Risk" />
              {detail?.readme && <Tab label="README" />}
            </Tabs>

            <Box sx={{ flex: 1, overflowY: "auto", p: 2 }}>
              {tab === 0 && (
                <Stack gap={2}>
                  <Typography variant="body2">{d.description}</Typography>

                  <Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      fontWeight={600}
                      display="block"
                      mb={0.5}
                    >
                      DOMAINS
                    </Typography>
                    <Stack direction="row" flexWrap="wrap" gap={0.5}>
                      {d.domains.map((dom) => (
                        <DomainChip key={dom} domain={dom} size="medium" />
                      ))}
                    </Stack>
                  </Box>

                  <Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      fontWeight={600}
                      display="block"
                      mb={0.5}
                    >
                      DETAILS
                    </Typography>
                    <Stack gap={0.5}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" color="text.secondary">
                          Version
                        </Typography>
                        <Typography variant="body2" fontWeight={500}>
                          {d.version}
                        </Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" color="text.secondary">
                          Min. platform
                        </Typography>
                        <Typography variant="body2" fontWeight={500}>
                          {d.minPlatform || "—"}
                        </Typography>
                      </Stack>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="body2" color="text.secondary">
                          Last updated
                        </Typography>
                        <Typography variant="body2" fontWeight={500}>
                          {new Date(d.lastUpdated).toLocaleDateString()}
                        </Typography>
                      </Stack>
                      {(detail as DetailResponse | undefined)?.installedAt && (
                        <Stack direction="row" justifyContent="space-between">
                          <Typography variant="body2" color="text.secondary">
                            Installed
                          </Typography>
                          <Typography variant="body2" fontWeight={500}>
                            {new Date(
                              (detail as DetailResponse).installedAt as string,
                            ).toLocaleDateString()}
                          </Typography>
                        </Stack>
                      )}
                    </Stack>
                  </Box>

                  {!d.compatible && (
                    <Alert severity="warning" icon={false}>
                      Requires platform ≥ {d.minPlatform}. This integration is not compatible with
                      your current installation.
                    </Alert>
                  )}

                  <Box>
                    <Link href={d.repository} target="_blank" rel="noopener noreferrer">
                      <Stack direction="row" alignItems="center" gap={0.5}>
                        <Typography variant="body2">View repository</Typography>
                        <OpenInNewIcon sx={{ fontSize: "0.9rem" }} />
                      </Stack>
                    </Link>
                  </Box>
                </Stack>
              )}

              {tab === 1 && <TrustDisclosure trust={inferCatalogTrust(d)} />}

              {tab === 2 && detail?.readme && <ReadmePanel text={detail.readme} />}
            </Box>

            <Divider />

            {/* Action bar */}
            <Box p={2}>
              {confirmRemove ? (
                <Stack gap={1}>
                  <Alert severity="warning" icon={false}>
                    Remove <strong>{d.name}</strong>? This will delete the integration files and
                    reload the integration host.
                  </Alert>
                  <Stack direction="row" gap={1}>
                    <Button
                      fullWidth
                      variant="contained"
                      color="error"
                      onClick={() => removeMutation.mutate()}
                      disabled={busy}
                    >
                      {removeMutation.isPending ? "Removing…" : "Confirm Remove"}
                    </Button>
                    <Button
                      fullWidth
                      variant="outlined"
                      onClick={() => setConfirmRemove(false)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                  </Stack>
                </Stack>
              ) : (
                <Stack direction="row" gap={1}>
                  {!d.installed && (
                    <Button
                      fullWidth
                      variant="contained"
                      onClick={() => installMutation.mutate()}
                      disabled={busy || !d.compatible}
                    >
                      {installMutation.isPending ? "Queuing…" : "Install"}
                    </Button>
                  )}
                  {d.installed && d.hasUpdate && (
                    <Button
                      fullWidth
                      variant="contained"
                      color="warning"
                      startIcon={<SystemUpdateAltIcon />}
                      onClick={() => updateMutation.mutate()}
                      disabled={busy}
                    >
                      {updateMutation.isPending ? "Queuing…" : "Update"}
                    </Button>
                  )}
                  {d.installed && !d.hasUpdate && (
                    <Button fullWidth variant="outlined" color="success" disabled>
                      Installed
                    </Button>
                  )}
                  {d.installed && (
                    <Tooltip title="Remove integration">
                      <Button
                        variant="outlined"
                        color="error"
                        onClick={() => setConfirmRemove(true)}
                        disabled={busy}
                        sx={{ minWidth: 40, px: 1.5 }}
                      >
                        <DeleteOutlineIcon />
                      </Button>
                    </Tooltip>
                  )}
                </Stack>
              )}
            </Box>
          </>
        )}
      </Drawer>

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast?.msg}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </>
  );
}

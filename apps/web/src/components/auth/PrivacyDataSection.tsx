"use client";

import DownloadIcon from "@mui/icons-material/Download";
import PrivacyTipIcon from "@mui/icons-material/PrivacyTip";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import {
  FRESH_SIGN_IN_REQUIRED,
  getPrivacyDataRequests,
  type PrivacyRequestView,
  requestPrivacyExport,
  withdrawPrivacyDataRequest,
} from "@openmapx/core";
import { acceptsWithdrawal } from "@openmapx/core/privacy";
import { useFormatter, useTranslations } from "next-intl";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { downloadPrivacyDeviceData } from "@/lib/privacyDeviceData";

/** Set before the fresh sign-in so the download continues on return. It holds
 * only a timestamp and expires with the sign-in window. */
export const PENDING_EXPORT_KEY = "openmapx:privacy:pending-export";
const PENDING_EXPORT_TTL_MS = 10 * 60_000;

function readPendingExport(): boolean {
  try {
    const raw = window.sessionStorage.getItem(PENDING_EXPORT_KEY);
    window.sessionStorage.removeItem(PENDING_EXPORT_KEY);
    const at = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at <= PENDING_EXPORT_TTL_MS;
  } catch {
    return false;
  }
}

function filenameFrom(response: Response): string {
  const match = /filename="([A-Za-z0-9][A-Za-z0-9._ -]*)"/.exec(
    response.headers.get("content-disposition") ?? "",
  );
  return match?.[1] ?? "openmapx-data-export.zip";
}

async function saveResponse(response: Response): Promise<void> {
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenameFrom(response);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export const PrivacyDataSection = forwardRef<HTMLHeadingElement>(
  function PrivacyDataSection(_props, headingRef) {
    const t = useTranslations("account");
    const format = useFormatter();
    const dateLabel = (value: string | null | undefined) => {
      if (!value) return "";
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? ""
        : format.dateTime(parsed, { dateStyle: "medium", timeStyle: "short" });
    };
    const [requests, setRequests] = useState<PrivacyRequestView[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const mounted = useRef(false);
    const loadVersion = useRef(0);
    const load = useCallback(async () => {
      if (!mounted.current) return;
      const version = ++loadVersion.current;
      const isCurrent = () => mounted.current && version === loadVersion.current;
      setLoading(true);
      try {
        const result = await getPrivacyDataRequests();
        if (!isCurrent()) return;
        setRequests(result.requests.slice(0, 20));
        setError(null);
      } catch {
        if (isCurrent()) setError(t("privacyData.loadFailed"));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, [t]);

    useEffect(() => {
      mounted.current = true;
      void load();
      return () => {
        mounted.current = false;
        ++loadVersion.current;
      };
    }, [load]);

    const download = useCallback(async () => {
      setBusy("export");
      setError(null);
      try {
        const response = await requestPrivacyExport("access_and_portability");
        if (response.status === 401) {
          const body = (await response.json().catch(() => null)) as { code?: string } | null;
          if (body?.code === FRESH_SIGN_IN_REQUIRED) {
            // A new interactive sign-in proves the request; the export then
            // continues when this page loads again.
            window.sessionStorage.setItem(PENDING_EXPORT_KEY, String(Date.now()));
            window.location.assign("/auth/privacy");
            return;
          }
        }
        if (!response.ok) throw new Error("export failed");
        await saveResponse(response);
      } catch {
        if (mounted.current) setError(t("privacyData.exportFailed"));
      } finally {
        if (mounted.current) {
          setBusy(null);
          void load();
        }
      }
    }, [load, t]);

    useEffect(() => {
      if (readPendingExport()) void download();
    }, [download]);

    const withdraw = async (request: PrivacyRequestView) => {
      setBusy(request.id);
      try {
        await withdrawPrivacyDataRequest(request.id, request.version);
        await load();
      } catch {
        setError(t("privacyData.actionFailed"));
      } finally {
        setBusy(null);
      }
    };

    return (
      <Box>
        <Typography
          ref={headingRef}
          tabIndex={-1}
          variant="subtitle2"
          sx={{ fontWeight: 600, mb: 1.5, outline: "none" }}
        >
          {t("privacyData.title")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          {t("privacyData.description")}
        </Typography>
        {error && (
          <Alert severity="warning" onClose={() => setError(null)} sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <Button
            variant="contained"
            size="small"
            startIcon={<PrivacyTipIcon />}
            onClick={() => void download()}
            disabled={busy !== null}
          >
            {busy === "export" ? <CircularProgress size={16} /> : t("privacyData.downloadExport")}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadIcon />}
            onClick={() => void downloadPrivacyDeviceData()}
          >
            {t("privacyData.downloadDevice")}
          </Button>
        </Box>
        <Divider sx={{ my: 1.5 }} />
        {loading ? (
          <CircularProgress size={20} />
        ) : requests.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("privacyData.noRequests")}
          </Typography>
        ) : (
          <List dense disablePadding>
            {requests.map((request) => (
              <ListItem
                key={request.id}
                disableGutters
                alignItems="flex-start"
                sx={{ display: "block", py: 1 }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <PrivacyTipIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary={t(`privacyData.states.${request.state}`)}
                    secondary={t("privacyData.due", { date: dateLabel(request.dueAt) })}
                  />
                  <Chip
                    size="small"
                    label={
                      request.kind === "access_and_portability"
                        ? t("privacyData.accessAndPortability")
                        : request.kind === "portability"
                          ? t("privacyData.portability")
                          : t("privacyData.access")
                    }
                  />
                </Box>
                {acceptsWithdrawal(request.state) && (
                  <Box sx={{ pl: 4, display: "flex", gap: 1, flexWrap: "wrap", mt: 0.75 }}>
                    <Button
                      size="small"
                      color="warning"
                      onClick={() => void withdraw(request)}
                      disabled={busy !== null}
                    >
                      {t("privacyData.withdraw")}
                    </Button>
                  </Box>
                )}
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    );
  },
);

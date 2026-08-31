"use client";

import AutorenewIcon from "@mui/icons-material/Autorenew";
import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useCreateShare, useRevokeShare, useRotateShare, useShares } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ShareLinkCreated } from "@/components/share/ShareLinkCreated";

const EXPIRY_OPTIONS = [
  { value: 0, key: "expiryNever" },
  { value: 1, key: "expiryDay" },
  { value: 7, key: "expiryWeek" },
  { value: 30, key: "expiryMonth" },
] as const;

interface Props {
  open: boolean;
  listId: string;
  listName: string;
  onClose: () => void;
}

export function ShareListDialog({ open, listId, listName, onClose }: Props) {
  const t = useTranslations("share");
  const tCommon = useTranslations("common");
  const [mode, setMode] = useState<"live" | "snapshot">("live");
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const { data: shares } = useShares(open);
  const createShare = useCreateShare();
  const rotateShare = useRotateShare();
  const revokeShare = useRevokeShare();

  const listShares = (shares ?? []).filter((s) => s.targetId === listId);

  const handleCreate = () => {
    setError(false);
    createShare.mutate(
      {
        targetType: "list",
        targetId: listId,
        mode,
        ...(expiresInDays > 0 ? { expiresInDays } : {}),
      },
      {
        onSuccess: (result) => setMintedToken(result.token),
        onError: () => setError(true),
      },
    );
  };

  const handleRotate = (id: string) => {
    setError(false);
    rotateShare.mutate(id, {
      onSuccess: (result) => setMintedToken(result.token),
      onError: () => setError(true),
    });
  };

  const handleClose = () => {
    setMintedToken(null);
    setError(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {t("shareList")}: {listName}
      </DialogTitle>
      <DialogContent>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("linkMode")}
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          onChange={(_e, value) => value && setMode(value)}
          sx={{ mb: 0.5 }}
        >
          <ToggleButton value="live">{t("modeLive")}</ToggleButton>
          <ToggleButton value="snapshot">{t("modeSnapshot")}</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 1.5 }}>
          {mode === "live" ? t("modeLiveHint") : t("modeSnapshotHint")}
        </Typography>
        <TextField
          select
          fullWidth
          size="small"
          label={t("expiry")}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(Number(e.target.value))}
        >
          {EXPIRY_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {t(option.key)}
            </MenuItem>
          ))}
        </TextField>
        <Button
          fullWidth
          variant="contained"
          onClick={handleCreate}
          disabled={createShare.isPending}
          sx={{ mt: 1.5, textTransform: "none" }}
        >
          {t("createLink")}
        </Button>
        {error && (
          <Typography variant="caption" sx={{ color: "error.main", display: "block", mt: 0.5 }}>
            {t("createFailed")}
          </Typography>
        )}
        {mintedToken && <ShareLinkCreated token={mintedToken} />}

        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2">{t("activeLinks")}</Typography>
        {listShares.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("noLinks")}
          </Typography>
        ) : (
          listShares.map((shareRow) => {
            const expired =
              shareRow.expiresAt !== null && new Date(shareRow.expiresAt).getTime() <= Date.now();
            return (
              <Box
                key={shareRow.id}
                sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {shareRow.mode === "live" ? t("modeLive") : t("modeSnapshot")}
                    {expired && ` · ${t("expiredBadge")}`}
                  </Typography>
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {new Date(shareRow.createdAt).toLocaleDateString()}
                  </Typography>
                </Box>
                <IconButton
                  size="small"
                  aria-label={t("rotateLink")}
                  onClick={() => handleRotate(shareRow.id)}
                >
                  <AutorenewIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={t("revokeLink")}
                  onClick={() => revokeShare.mutate(shareRow.id)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            );
          })
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} sx={{ textTransform: "none" }}>
          {tCommon("close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

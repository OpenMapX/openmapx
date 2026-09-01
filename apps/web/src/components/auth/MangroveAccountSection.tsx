"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import KeyIcon from "@mui/icons-material/Key";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemSecondaryAction from "@mui/material/ListItemSecondaryAction";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { fingerprintPem, isWebAuthnAvailable } from "@openmapx/mangrove-client";
import {
  type KeypairWrap,
  useAddWrap,
  useChangePassphrase,
  useKeypairState,
  useRegenerateMangroveKeypair,
  useRemoveWrap,
  useUserKeypair,
} from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { MangroveExportDialog } from "./MangroveExportDialog";
import { MangroveSetupWizard } from "./MangroveSetupWizard";
import { MangroveUnlockDialog } from "./MangroveUnlockDialog";

const MANGROVE_HOME_URL = "https://mangrove.reviews/";

export function MangroveAccountSection() {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const fmt = useDateTimeFormat();
  const { publicPem, needsSetup, needsUnlock } = useUserKeypair();
  const state = useKeypairState();
  const addWrap = useAddWrap();
  const removeWrap = useRemoveWrap();
  const regenerate = useRegenerateMangroveKeypair();
  const changePassphrase = useChangePassphrase();

  const [setupOpen, setSetupOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [addPassphraseOpen, setAddPassphraseOpen] = useState(false);
  const [changePassphraseOpen, setChangePassphraseOpen] = useState(false);
  const [newPassphrase, setNewPassphrase] = useState("");
  const [newPassphraseConfirm, setNewPassphraseConfirm] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);

  const envelope = state.data?.state === "ready" ? state.data : null;
  const mode = envelope?.mode;
  const wraps: KeypairWrap[] = envelope?.mode === "encrypted" ? envelope.wraps : [];
  const webauthnAvailable = isWebAuthnAvailable();
  const fingerprint = publicPem ? fingerprintPem(publicPem) : null;

  async function handleAddPassphrase() {
    setAddError(null);
    if (newPassphrase.length < 8) {
      setAddError(t("mangrovePassphraseTooShort"));
      return;
    }
    if (newPassphrase !== newPassphraseConfirm) {
      setAddError(t("mangrovePassphraseMismatch"));
      return;
    }
    if (needsUnlock) {
      setAddError(t("mangroveMustUnlockFirst"));
      return;
    }
    try {
      await addWrap.mutateAsync({ wrapType: "passphrase", passphrase: newPassphrase });
      setAddPassphraseOpen(false);
      setNewPassphrase("");
      setNewPassphraseConfirm("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("mangroveAddFailed"));
    }
  }

  async function handleAddPasskey() {
    if (needsUnlock) {
      setUnlockOpen(true);
      return;
    }
    try {
      await addWrap.mutateAsync({ wrapType: "webauthn" });
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("mangroveAddFailed"));
    }
  }

  async function handleRegenerate() {
    await regenerate.mutateAsync();
    setRegenerateOpen(false);
    setSetupOpen(true);
  }

  async function handleChangePassphrase() {
    setChangeError(null);
    if (newPassphrase.length < 8) {
      setChangeError(t("mangrovePassphraseTooShort"));
      return;
    }
    if (newPassphrase !== newPassphraseConfirm) {
      setChangeError(t("mangrovePassphraseMismatch"));
      return;
    }
    try {
      await changePassphrase.mutateAsync({ passphrase: newPassphrase });
      setChangePassphraseOpen(false);
      setNewPassphrase("");
      setNewPassphraseConfirm("");
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : t("mangroveChangePassphraseFailed"));
    }
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        {t.rich("mangroveSectionTitle", {
          m: (chunks) => (
            <Box
              component="a"
              href={MANGROVE_HOME_URL}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ color: "primary.main", textDecoration: "underline" }}
            >
              {chunks}
            </Box>
          ),
        })}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 1.5,
        }}
      >
        {t("mangroveSectionIntro")}
      </Typography>
      {needsSetup && (
        <Alert
          severity="info"
          sx={{ mb: 1.5 }}
          action={
            <Button color="inherit" size="small" onClick={() => setSetupOpen(true)}>
              {t("mangroveSetupStart")}
            </Button>
          }
        >
          {t("mangroveSetupPrompt")}
        </Alert>
      )}
      {!needsSetup && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              p: 1.5,
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 1,
              mb: 1.5,
            }}
          >
            {mode === "encrypted" ? (
              <LockIcon sx={{ color: "success.main" }} />
            ) : (
              <LockOpenIcon sx={{ color: "warning.main" }} />
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                }}
              >
                {mode === "encrypted" ? t("mangroveEncryptedBadge") : t("mangroveUnencryptedBadge")}
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <FingerprintIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                <Typography
                  variant="body2"
                  sx={{ fontFamily: "monospace", fontSize: 13 }}
                  title={publicPem ?? undefined}
                >
                  {fingerprint ? `${fingerprint}…` : "—"}
                </Typography>
              </Box>
            </Box>
            {needsUnlock && (
              <Button size="small" variant="outlined" onClick={() => setUnlockOpen(true)}>
                {t("mangroveUnlockCta")}
              </Button>
            )}
          </Box>

          {mode === "unencrypted" && (
            <Alert severity="warning" sx={{ mb: 1.5 }} icon={<WarningAmberIcon />}>
              <AlertTitle>{t("mangroveUnencryptedBadgeAlertTitle")}</AlertTitle>
              {t("mangroveUnencryptedBadgeAlertBody")}
            </Alert>
          )}

          {mode === "encrypted" && (
            <>
              <Typography variant="body2" sx={{ fontWeight: 600, mt: 2, mb: 0.5 }}>
                {t("mangroveUnlockMethods")}
              </Typography>
              <List
                dense
                sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 0 }}
              >
                {wraps.map((w) => (
                  <ListItem
                    key={w.id}
                    sx={{
                      "&:not(:last-child)": {
                        borderBottom: "1px solid",
                        borderColor: "divider",
                      },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      {w.wrapType === "passphrase" ? (
                        <KeyIcon fontSize="small" />
                      ) : (
                        <FingerprintIcon fontSize="small" />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                          <span>{w.label}</span>
                          <Chip
                            size="small"
                            label={
                              w.wrapType === "passphrase"
                                ? t("mangroveWrapPassphrase")
                                : t("mangroveWrapPasskey")
                            }
                            sx={{ height: 18, fontSize: 11 }}
                          />
                        </Box>
                      }
                      secondary={fmt.date(w.createdAt)}
                    />
                    <ListItemSecondaryAction>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{
                          alignItems: "center",
                        }}
                      >
                        {w.wrapType === "passphrase" && (
                          <Tooltip title={t("mangroveChangePassphrase")}>
                            <span>
                              <IconButton
                                size="small"
                                disabled={needsUnlock || changePassphrase.isPending}
                                onClick={() => {
                                  setChangeError(null);
                                  setNewPassphrase("");
                                  setNewPassphraseConfirm("");
                                  setChangePassphraseOpen(true);
                                }}
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip
                          title={
                            wraps.length === 1
                              ? t("mangroveRemoveLastDisabled")
                              : t("mangroveRemoveWrap")
                          }
                        >
                          <span>
                            <IconButton
                              edge="end"
                              size="small"
                              disabled={wraps.length === 1 || removeWrap.isPending}
                              onClick={() => removeWrap.mutate(w.id)}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </ListItemSecondaryAction>
                  </ListItem>
                ))}
              </List>

              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: "wrap", gap: 1 }}>
                {!wraps.some((w) => w.wrapType === "passphrase") && (
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => setAddPassphraseOpen(true)}
                    disabled={needsUnlock}
                  >
                    {t("mangroveAddPassphrase")}
                  </Button>
                )}
                <Tooltip title={!webauthnAvailable ? t("mangroveWebAuthnUnavailable") : ""}>
                  <span>
                    <Button
                      size="small"
                      startIcon={addWrap.isPending ? <CircularProgress size={14} /> : <AddIcon />}
                      onClick={handleAddPasskey}
                      disabled={needsUnlock || !webauthnAvailable || addWrap.isPending}
                    >
                      {t("mangroveAddPasskey")}
                    </Button>
                  </span>
                </Tooltip>
              </Stack>

              {needsUnlock && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    mt: 1,
                    display: "block",
                  }}
                >
                  {t("mangroveMustUnlockForChanges")}
                </Typography>
              )}

              {addWrap.isError && (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                  {addWrap.error instanceof Error ? addWrap.error.message : t("mangroveAddFailed")}
                </Alert>
              )}
            </>
          )}

          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap", gap: 1 }}>
            <Button
              size="small"
              startIcon={<FileDownloadOutlinedIcon />}
              onClick={() => setExportOpen(true)}
              disabled={needsUnlock}
            >
              {t("mangroveExportCta")}
            </Button>
            <Button
              size="small"
              color="warning"
              startIcon={<RefreshIcon />}
              onClick={() => setRegenerateOpen(true)}
            >
              {t("mangroveRegenerateCta")}
            </Button>
          </Stack>
        </>
      )}
      <MangroveSetupWizard
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onDone={() => state.refetch()}
      />
      <MangroveUnlockDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} />
      <MangroveExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {/* Add passphrase dialog */}
      <Dialog
        open={addPassphraseOpen}
        onClose={() => {
          setAddPassphraseOpen(false);
          setAddError(null);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t("mangroveAddPassphraseTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>{t("mangroveAddPassphraseHelp")}</DialogContentText>
          <Stack spacing={2}>
            <TextField
              type="password"
              label={t("mangrovePassphraseLabel")}
              value={newPassphrase}
              onChange={(e) => setNewPassphrase(e.target.value)}
              autoFocus
              autoComplete="new-password"
              fullWidth
            />
            <TextField
              type="password"
              label={t("mangrovePassphraseConfirmLabel")}
              value={newPassphraseConfirm}
              onChange={(e) => setNewPassphraseConfirm(e.target.value)}
              autoComplete="new-password"
              fullWidth
            />
            {addError && <Alert severity="error">{addError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setAddPassphraseOpen(false);
              setAddError(null);
            }}
            color="inherit"
            disabled={addWrap.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={handleAddPassphrase}
            disabled={!newPassphrase || !newPassphraseConfirm || addWrap.isPending}
            startIcon={addWrap.isPending ? <CircularProgress size={16} /> : null}
          >
            {tc("confirm")}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Change passphrase dialog */}
      <Dialog
        open={changePassphraseOpen}
        onClose={() => {
          if (changePassphrase.isPending) return;
          setChangePassphraseOpen(false);
          setChangeError(null);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t("mangroveChangePassphraseTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>{t("mangroveChangePassphraseHelp")}</DialogContentText>
          <Stack spacing={2}>
            <TextField
              type="password"
              label={t("mangrovePassphraseLabel")}
              value={newPassphrase}
              onChange={(e) => setNewPassphrase(e.target.value)}
              autoFocus
              autoComplete="new-password"
              fullWidth
            />
            <TextField
              type="password"
              label={t("mangrovePassphraseConfirmLabel")}
              value={newPassphraseConfirm}
              onChange={(e) => setNewPassphraseConfirm(e.target.value)}
              autoComplete="new-password"
              fullWidth
            />
            {changeError && <Alert severity="error">{changeError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setChangePassphraseOpen(false);
              setChangeError(null);
            }}
            color="inherit"
            disabled={changePassphrase.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={handleChangePassphrase}
            disabled={!newPassphrase || !newPassphraseConfirm || changePassphrase.isPending}
            startIcon={changePassphrase.isPending ? <CircularProgress size={16} /> : null}
          >
            {tc("confirm")}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Regenerate confirmation */}
      <Dialog
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t("mangroveRegenerateTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("mangroveRegenerateConfirm")}</DialogContentText>
          {regenerate.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {regenerate.error instanceof Error
                ? regenerate.error.message
                : t("mangroveRegenerateFailed")}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setRegenerateOpen(false)}
            color="inherit"
            disabled={regenerate.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={handleRegenerate}
            disabled={regenerate.isPending}
            startIcon={regenerate.isPending ? <CircularProgress size={16} /> : <RefreshIcon />}
          >
            {t("mangroveRegenerateCta")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

"use client";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import KeyIcon from "@mui/icons-material/Key";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import LoginIcon from "@mui/icons-material/Login";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { fingerprintPem, isWebAuthnAvailable, publicKeyToPem } from "@openmapx/mangrove-client";
import { useSetupKeypair } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";

type Mode = "unencrypted" | "passphrase" | "passphrase+webauthn";
type Step = "chooseMode" | "importJwk" | "configure" | "confirmUnencrypted";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after successful setup. */
  onDone?: () => void;
  /** Pre-filled JWK when the flow is triggered externally. */
  importJwk?: JsonWebKey;
  rpId?: string;
}

/** Derive a short fingerprint from a JWK for display in the "imported" chip. */
async function fingerprintFromJwk(jwk: JsonWebKey): Promise<string> {
  const pub: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const pubKey = await crypto.subtle.importKey(
    "jwk",
    pub,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const pem = await publicKeyToPem(pubKey);
  return fingerprintPem(pem);
}

function parseImportJwk(input: string): JsonWebKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("json");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("shape");
  const jwk = parsed as Partial<JsonWebKey>;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    typeof jwk.d !== "string"
  ) {
    throw new Error("shape");
  }
  return jwk as JsonWebKey;
}

export function MangroveSetupWizard({
  open,
  onClose,
  onDone,
  importJwk: externalImportJwk,
  rpId,
}: Props) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const fullScreen = useFullScreenOnMobile();
  const setup = useSetupKeypair();

  const [step, setStep] = useState<Step>("chooseMode");
  const [mode, setMode] = useState<Mode>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [importInput, setImportInput] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [internalImportJwk, setInternalImportJwk] = useState<JsonWebKey | null>(null);
  const [importedFingerprint, setImportedFingerprint] = useState<string | null>(null);

  const effectiveImportJwk = internalImportJwk ?? externalImportJwk;
  const webauthnAvailable = isWebAuthnAvailable();

  function resetFlow() {
    setStep("chooseMode");
    setPassphrase("");
    setPassphraseConfirm("");
    setImportInput("");
    setImportError(null);
    setInternalImportJwk(null);
    setImportedFingerprint(null);
    setError(null);
  }

  function pickMode(next: Mode) {
    setMode(next);
    setError(null);
    if (next === "unencrypted") setStep("confirmUnencrypted");
    else setStep("configure");
  }

  async function handleImportConfirm() {
    setImportError(null);
    try {
      const jwk = parseImportJwk(importInput);
      const fp = await fingerprintFromJwk(jwk);
      setInternalImportJwk(jwk);
      setImportedFingerprint(fp);
      setStep("chooseMode");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setImportError(msg === "json" ? t("mangroveImportInvalidJson") : t("mangroveImportFailed"));
    }
  }

  function handleImportClear() {
    setInternalImportJwk(null);
    setImportedFingerprint(null);
    setImportInput("");
    setImportError(null);
  }

  async function handleSubmit() {
    setError(null);
    try {
      if (mode === "unencrypted") {
        await setup.mutateAsync({ mode: "unencrypted", importJwk: effectiveImportJwk });
      } else if (mode === "passphrase") {
        if (passphrase.length < 8) {
          setError(t("mangrovePassphraseTooShort"));
          return;
        }
        if (passphrase !== passphraseConfirm) {
          setError(t("mangrovePassphraseMismatch"));
          return;
        }
        await setup.mutateAsync({
          mode: "passphrase",
          passphrase,
          importJwk: effectiveImportJwk,
        });
      } else {
        if (passphrase.length < 8) {
          setError(t("mangrovePassphraseTooShort"));
          return;
        }
        if (passphrase !== passphraseConfirm) {
          setError(t("mangrovePassphraseMismatch"));
          return;
        }
        await setup.mutateAsync({
          mode: "passphrase+webauthn",
          passphrase,
          rpId,
          importJwk: effectiveImportJwk,
        });
      }
      resetFlow();
      onDone?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mangroveSetupFailed"));
    }
  }

  function handleClose() {
    if (setup.isPending) return;
    resetFlow();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle>
        {step === "chooseMode"
          ? t("mangroveSetupTitle")
          : step === "importJwk"
            ? t("mangroveImportTitle")
            : step === "confirmUnencrypted"
              ? t("mangroveSetupUnencryptedConfirmTitle")
              : mode === "passphrase+webauthn"
                ? t("mangroveSetupPassphraseWebAuthnTitle")
                : t("mangroveSetupPassphraseTitle")}
      </DialogTitle>
      <DialogContent dividers>
        {step === "chooseMode" && (
          <>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2,
              }}
            >
              {t("mangroveSetupIntro")}
            </Typography>

            {importedFingerprint && (
              <Alert
                severity="success"
                icon={<LoginIcon />}
                sx={{ mb: 2 }}
                action={
                  <Button color="inherit" size="small" onClick={handleImportClear}>
                    <DeleteOutlineIcon fontSize="small" />
                  </Button>
                }
              >
                <AlertTitle>{t("mangroveImportLoadedTitle")}</AlertTitle>
                {t.rich("mangroveImportLoadedBody", {
                  fp: () => (
                    <Chip
                      size="small"
                      label={importedFingerprint}
                      sx={{ fontFamily: "monospace", height: 20, fontSize: 12, ml: 0.5 }}
                    />
                  ),
                })}
              </Alert>
            )}

            {!importedFingerprint && (
              <Button
                fullWidth
                variant="outlined"
                size="large"
                startIcon={<LoginIcon />}
                onClick={() => {
                  setImportError(null);
                  setStep("importJwk");
                }}
                sx={{ mb: 2, justifyContent: "flex-start", py: 1.25, textTransform: "none" }}
              >
                {t("mangroveImportCta")}
              </Button>
            )}

            <Alert severity="info" icon={<FingerprintIcon />} sx={{ mb: 2 }}>
              <AlertTitle>{t("mangrovePassphraseDifferenceTitle")}</AlertTitle>
              {t("mangrovePassphraseDifferenceBody")}
            </Alert>

            <Stack spacing={1.5}>
              <ModeCard
                icon={<KeyIcon />}
                title={t("mangroveModePassphraseTitle")}
                subtitle={t("mangroveModePassphraseSubtitle")}
                recommended
                onClick={() => pickMode("passphrase")}
              />
              <ModeCard
                icon={<FingerprintIcon />}
                title={t("mangroveModePassphraseWebAuthnTitle")}
                subtitle={t("mangroveModePassphraseWebAuthnSubtitle")}
                disabled={!webauthnAvailable}
                disabledHint={!webauthnAvailable ? t("mangroveWebAuthnUnavailable") : undefined}
                onClick={() => pickMode("passphrase+webauthn")}
              />
              <ModeCard
                icon={<LockOpenIcon />}
                title={t("mangroveModeUnencryptedTitle")}
                subtitle={t("mangroveModeUnencryptedSubtitle")}
                warning
                onClick={() => pickMode("unencrypted")}
              />
            </Stack>
          </>
        )}

        {step === "importJwk" && (
          <Stack spacing={2}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("mangroveImportHelp")}
            </Typography>
            <Alert severity="warning" icon={<WarningAmberIcon />}>
              {t("mangroveImportWarning")}
            </Alert>
            <TextField
              label={t("mangroveImportLabel")}
              value={importInput}
              onChange={(e) => {
                setImportInput(e.target.value);
                setImportError(null);
              }}
              multiline
              minRows={6}
              autoFocus
              fullWidth
              placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}'
              slotProps={{
                input: { sx: { fontFamily: "monospace", fontSize: 13 } },
              }}
            />
            {importError && <Alert severity="error">{importError}</Alert>}
          </Stack>
        )}

        {step === "configure" && (
          <Stack spacing={2}>
            <Alert severity="warning" icon={<WarningAmberIcon />}>
              <AlertTitle>{t("mangroveLossWarningTitle")}</AlertTitle>
              {t("mangroveLossWarningBody")}
            </Alert>

            <TextField
              type="password"
              label={t("mangrovePassphraseLabel")}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              autoComplete="new-password"
              fullWidth
              helperText={t("mangrovePassphraseHelper")}
            />
            <TextField
              type="password"
              label={t("mangrovePassphraseConfirmLabel")}
              value={passphraseConfirm}
              onChange={(e) => setPassphraseConfirm(e.target.value)}
              autoComplete="new-password"
              fullWidth
            />

            {mode === "passphrase+webauthn" && (
              <Alert severity="info" icon={<FingerprintIcon />}>
                <AlertTitle>{t("mangroveWebAuthnStepTitle")}</AlertTitle>
                {t("mangroveWebAuthnStepBody")}
              </Alert>
            )}

            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}

        {step === "confirmUnencrypted" && (
          <Stack spacing={2}>
            <Alert severity="error" icon={<WarningAmberIcon />}>
              <AlertTitle>{t("mangroveUnencryptedWarningTitle")}</AlertTitle>
              {t("mangroveUnencryptedWarningBody")}
            </Alert>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("mangroveUnencryptedAck")}
            </Typography>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {step !== "chooseMode" ? (
          <Button
            color="inherit"
            onClick={() => {
              setStep("chooseMode");
              setError(null);
            }}
            disabled={setup.isPending}
          >
            {tc("back")}
          </Button>
        ) : (
          <Button color="inherit" onClick={handleClose} disabled={setup.isPending}>
            {tc("cancel")}
          </Button>
        )}
        {step === "importJwk" && (
          <Button
            variant="contained"
            onClick={handleImportConfirm}
            disabled={!importInput.trim()}
            startIcon={<LoginIcon />}
          >
            {tc("confirm")}
          </Button>
        )}
        {step === "configure" && (
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={!passphrase || !passphraseConfirm || setup.isPending}
            startIcon={
              setup.isPending ? <CircularProgress size={16} /> : <CheckCircleOutlineIcon />
            }
          >
            {t("mangroveSetupContinue")}
          </Button>
        )}
        {step === "confirmUnencrypted" && (
          <Button
            variant="contained"
            color="warning"
            onClick={handleSubmit}
            disabled={setup.isPending}
            startIcon={setup.isPending ? <CircularProgress size={16} /> : null}
          >
            {t("mangroveUnencryptedProceed")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

interface ModeCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  recommended?: boolean;
  warning?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onClick: () => void;
}

function ModeCard({
  icon,
  title,
  subtitle,
  recommended,
  warning,
  disabled,
  disabledHint,
  onClick,
}: ModeCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: recommended ? "primary.main" : warning ? "warning.main" : "divider",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <CardActionArea onClick={onClick} disabled={disabled}>
        <CardContent>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
            <Box sx={{ mt: 0.5, color: warning ? "warning.main" : "primary.main" }}>{icon}</Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.25 }}>
                {title}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {subtitle}
              </Typography>
              {disabledHint && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.disabled",
                    mt: 0.5,
                    display: "block",
                  }}
                >
                  {disabledHint}
                </Typography>
              )}
            </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

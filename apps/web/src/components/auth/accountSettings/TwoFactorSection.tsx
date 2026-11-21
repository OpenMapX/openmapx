import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import KeyIcon from "@mui/icons-material/Key";
import SecurityIcon from "@mui/icons-material/Security";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { type ReactNode, useEffect, useState } from "react";
import { AccountSectionTitle, type SetAccountMessage } from "./shared";

function BackupCodesList({ codes }: { codes: string[] }) {
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: 1,
        p: 2,
        fontFamily: "monospace",
        fontSize: 13,
        mb: 1,
      }}
    >
      {codes.map((code) => (
        <Box key={code}>{code}</Box>
      ))}
    </Box>
  );
}

/** Copy and download buttons for freshly issued backup codes, followed by `children`. */
function BackupCodeActions({
  codes,
  copyLabel,
  setMessage,
  children,
}: {
  codes: string[];
  copyLabel: string;
  setMessage: SetAccountMessage;
  children?: ReactNode;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setMessage({ type: "success", text: t("backupCodesCopied") });
    } catch {
      setMessage({ type: "error", text: t("backupCodesCopyFailed") });
    }
  };

  const download = () => {
    const content = `OpenMapX Backup Codes\n${"=".repeat(22)}\n\n${codes.join("\n")}\n\nEach code can only be used once.\nStore these codes in a safe place.\n`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "openmapx-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button size="small" startIcon={<ContentCopyIcon />} onClick={copy}>
        {copyLabel}
      </Button>
      <Button size="small" startIcon={<DownloadIcon />} onClick={download}>
        {tc("download")}
      </Button>
      {children}
    </>
  );
}

function PasswordConfirmField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("account");
  return (
    <TextField
      fullWidth
      label={t("password")}
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      size="small"
      sx={{ mb: 1.5 }}
      autoComplete="current-password"
    />
  );
}

/** Regenerating backup codes and turning two-factor sign-in off, once it is on. */
function TwoFactorEnabledPanel({
  onDisabled,
  setMessage,
}: {
  onDisabled: () => void;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [panel, setPanel] = useState<"actions" | "backup-codes" | "disable">("actions");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const showPanel = (next: typeof panel) => {
    setPanel(next);
    setPassword("");
    setBackupCodes(null);
  };

  const regenerateBackupCodes = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
      if (error) {
        setMessage({
          type: "error",
          text: String(error.message ?? t("failedGenerateBackupCodes")),
        });
        return;
      }
      if (data) {
        setBackupCodes(data.backupCodes);
        setMessage({ type: "success", text: t("newBackupCodesGenerated") });
      }
    } catch {
      setMessage({ type: "error", text: t("failedGenerateBackupCodes") });
    }
  };

  const disable = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedDisable2FA")) });
        return;
      }
      onDisabled();
      setMessage({ type: "success", text: t("twoFADisabled") });
    } catch {
      setMessage({ type: "error", text: t("failedDisable2FA") });
    }
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
        <SecurityIcon fontSize="small" color="success" />
        <Typography variant="body2" sx={{ color: "success.main", flex: 1 }}>
          {t("twoFAEnabled")}
        </Typography>
      </Box>

      {panel === "actions" && (
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<KeyIcon />}
            onClick={() => showPanel("backup-codes")}
          >
            {t("backupCodes")}
          </Button>
          <Button size="small" color="error" onClick={() => showPanel("disable")}>
            {t("disable2FA")}
          </Button>
        </Box>
      )}

      {panel === "backup-codes" && !backupCodes && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            {t("enterPasswordToRegenerate")}
          </Typography>
          <PasswordConfirmField value={password} onChange={setPassword} />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              color="warning"
              onClick={() => {
                if (window.confirm(t("regenerateCodesConfirm"))) void regenerateBackupCodes();
              }}
              disabled={!password}
            >
              {t("regenerateCodes")}
            </Button>
            <Button variant="outlined" size="small" onClick={() => showPanel("actions")}>
              {tc("cancel")}
            </Button>
          </Box>
        </Box>
      )}

      {panel === "backup-codes" && backupCodes && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("saveBackupCodes")}
          </Typography>
          <BackupCodesList codes={backupCodes} />
          <Box sx={{ display: "flex", gap: 1 }}>
            <BackupCodeActions codes={backupCodes} copyLabel={tc("copy")} setMessage={setMessage}>
              <Button size="small" variant="outlined" onClick={() => showPanel("actions")}>
                {tc("done")}
              </Button>
            </BackupCodeActions>
          </Box>
        </Box>
      )}

      {panel === "disable" && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="error" sx={{ mb: 1 }}>
            {t("enterPasswordToDisable")}
          </Typography>
          <PasswordConfirmField value={password} onChange={setPassword} />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              color="error"
              size="small"
              onClick={disable}
              disabled={!password}
            >
              {t("disable2FA")}
            </Button>
            <Button variant="outlined" size="small" onClick={() => showPanel("actions")}>
              {tc("cancel")}
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Setting up two-factor sign-in: password, then the authenticator QR code and a first code. */
function TwoFactorSetup({
  onEnabled,
  setMessage,
}: {
  onEnabled: () => void;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [settingUp, setSettingUp] = useState(false);
  const [password, setPassword] = useState("");
  const [totpSetupUri, setTotpSetupUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!totpSetupUri) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(totpSetupUri, { width: 200, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [totpSetupUri]);

  const cancel = () => {
    setSettingUp(false);
    setTotpSetupUri(null);
    setBackupCodes(null);
    setPassword("");
    setVerifyCode("");
  };

  const enable = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.enable({ password, method: "totp" });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedEnable2FA")) });
        return;
      }
      if (data?.method === "totp") {
        setTotpSetupUri(data.totpURI);
        setBackupCodes(data.backupCodes);
      } else if (data) {
        setMessage({ type: "error", text: t("failedEnable2FA") });
      }
    } catch {
      setMessage({ type: "error", text: t("failedEnable2FA") });
    }
  };

  const verify = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: verifyCode });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("invalidCode")) });
        return;
      }
      onEnabled();
      setMessage({ type: "success", text: t("twoFAEnabled2") });
    } catch {
      setMessage({ type: "error", text: t("failedVerifyCode") });
    }
  };

  if (!settingUp) {
    return (
      <Box sx={{ mb: 3 }}>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          {t("twoFADescription")}
        </Typography>
        <Button size="small" startIcon={<SecurityIcon />} onClick={() => setSettingUp(true)}>
          {t("setUp2FA")}
        </Button>
      </Box>
    );
  }

  if (!totpSetupUri) {
    return (
      <Box sx={{ mb: 3 }}>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {t("enterPasswordToSetup")}
        </Typography>
        <PasswordConfirmField value={password} onChange={setPassword} />
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button variant="contained" size="small" onClick={enable} disabled={!password}>
            {tc("continue")}
          </Button>
          <Button variant="outlined" size="small" onClick={cancel}>
            {tc("cancel")}
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="body2" sx={{ mb: 1.5 }}>
        {t("scanQRCode")}
      </Typography>
      <Box sx={{ textAlign: "center", mb: 2 }}>
        {qrDataUrl && (
          <Box
            component="img"
            src={qrDataUrl}
            alt={t("totpQRCodeAlt")}
            sx={{ width: 200, height: 200, borderRadius: 1 }}
          />
        )}
      </Box>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block", mb: 2, wordBreak: "break-all" }}
      >
        {t("orEnterManually", { uri: totpSetupUri })}
      </Typography>

      {backupCodes && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
            {t("backupCodesTitle")}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("saveCodesDescription")}
          </Typography>
          <BackupCodesList codes={backupCodes} />
          <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
            <BackupCodeActions
              codes={backupCodes}
              copyLabel={t("copyCodes")}
              setMessage={setMessage}
            />
          </Box>
        </Box>
      )}

      <Typography variant="body2" sx={{ mb: 1 }}>
        {t("enterCodeToVerify")}
      </Typography>
      <TextField
        fullWidth
        label={t("verificationCode")}
        value={verifyCode}
        onChange={(e) => setVerifyCode(e.target.value)}
        size="small"
        sx={{ mb: 1.5 }}
        autoComplete="one-time-code"
        slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }}
      />
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button variant="contained" size="small" onClick={verify} disabled={verifyCode.length < 6}>
          {t("verifyAndEnable")}
        </Button>
        <Button variant="outlined" size="small" onClick={cancel}>
          {tc("cancel")}
        </Button>
      </Box>
    </Box>
  );
}

export function TwoFactorSection({
  initiallyEnabled,
  setMessage,
}: {
  initiallyEnabled: boolean;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const [enabled, setEnabled] = useState(initiallyEnabled);
  return (
    <>
      <AccountSectionTitle>{t("twoFactorAuth")}</AccountSectionTitle>
      {enabled ? (
        <TwoFactorEnabledPanel onDisabled={() => setEnabled(false)} setMessage={setMessage} />
      ) : (
        <TwoFactorSetup onEnabled={() => setEnabled(true)} setMessage={setMessage} />
      )}
    </>
  );
}

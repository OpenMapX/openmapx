import LockIcon from "@mui/icons-material/Lock";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AccountSectionTitle, type SetAccountMessage } from "./shared";

function PasswordField({
  label,
  toggleLabel,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  toggleLabel: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      fullWidth
      label={label}
      type={shown ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      size="small"
      sx={{ mb: 1.5 }}
      autoComplete={autoComplete}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                aria-label={toggleLabel}
                onClick={() => setShown(!shown)}
                edge="end"
                size="small"
              >
                {shown ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

export function PasswordSection({ setMessage }: { setMessage: SetAccountMessage }) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const [changing, setChanging] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const stopChanging = () => {
    setChanging(false);
    setCurrentPassword("");
    setNewPassword("");
  };

  const changePassword = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedChangePassword")) });
        return;
      }
      setMessage({ type: "success", text: t("passwordChanged") });
      stopChanging();
    } catch {
      setMessage({ type: "error", text: t("failedChangePassword") });
    }
  };

  return (
    <>
      <AccountSectionTitle>{t("password")}</AccountSectionTitle>
      {!changing ? (
        <Box sx={{ mb: 3 }}>
          <Button size="small" startIcon={<LockIcon />} onClick={() => setChanging(true)}>
            {t("changePassword")}
          </Button>
        </Box>
      ) : (
        <Box sx={{ mb: 3 }}>
          <PasswordField
            label={t("currentPassword")}
            toggleLabel={t("toggleCurrentPasswordVisibility")}
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
          />
          <PasswordField
            label={t("newPassword")}
            toggleLabel={t("toggleNewPasswordVisibility")}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              onClick={changePassword}
              disabled={!currentPassword || !newPassword}
            >
              {t("updatePassword")}
            </Button>
            <Button variant="outlined" size="small" onClick={stopChanging}>
              {tc("cancel")}
            </Button>
          </Box>
        </Box>
      )}
    </>
  );
}

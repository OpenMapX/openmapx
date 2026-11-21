import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import type { User } from "@openmapx/core";
import { authClient, getInitials, proxyImageUrl } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AccountSectionTitle, type SetAccountMessage } from "./shared";

export function ProfileSection({
  user,
  setMessage,
}: {
  user: User;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);

  const updateProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("updateFailed")) });
      } else {
        setMessage({ type: "success", text: t("profileUpdated") });
      }
    } catch {
      setMessage({ type: "error", text: t("unexpectedError") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AccountSectionTitle>{t("profile")}</AccountSectionTitle>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
        <Avatar
          src={user.image ? proxyImageUrl(user.image) : undefined}
          sx={{ width: 56, height: 56, bgcolor: "primary.main", fontSize: 22 }}
        >
          {getInitials(user.name, user.email)}
        </Avatar>
        <Box sx={{ flex: 1 }}>
          <TextField
            fullWidth
            label={t("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
          />
        </Box>
      </Box>
      <Button
        variant="contained"
        size="small"
        onClick={updateProfile}
        disabled={saving || name === user.name}
        sx={{ mb: 3 }}
      >
        {t("saveChanges")}
      </Button>
    </>
  );
}

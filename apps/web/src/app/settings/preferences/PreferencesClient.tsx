"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { haptics, hapticsSupported, isHapticsEnabled, setHapticsEnabled } from "@/lib/haptics";

export function PreferencesClient() {
  const t = useTranslations("settings");
  const [hapticsOn, setHapticsOn] = useState(true);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setHapticsOn(isHapticsEnabled());
    setSupported(hapticsSupported());
  }, []);

  const handleToggle = (next: boolean) => {
    setHapticsOn(next);
    setHapticsEnabled(next);
    if (next) haptics.success(); // let the user feel what they just enabled
  };

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("preferencesTitle")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {t("preferencesDescription")}
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={hapticsOn && supported}
              disabled={!supported}
              onChange={(e) => handleToggle(e.target.checked)}
            />
          }
          label={
            <Stack spacing={0.5}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {t("haptics")}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {supported ? t("hapticsDescription") : t("hapticsUnsupported")}
              </Typography>
            </Stack>
          }
          sx={{ alignItems: "flex-start", m: 0 }}
        />
      </Paper>
    </Stack>
  );
}

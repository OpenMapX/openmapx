"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { haptics, hapticsSupported, isHapticsEnabled, setHapticsEnabled } from "@/lib/haptics";
import { useHydrated } from "@/lib/useHydrated";

export function PreferencesClient() {
  const t = useTranslations("settings");
  const hydrated = useHydrated();
  const [hapticsOverride, setHapticsOn] = useState<boolean | null>(null);
  const hapticsOn = hapticsOverride ?? (hydrated ? isHapticsEnabled() : true);
  const supported = hydrated ? hapticsSupported() : true;

  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const toggleVoice = useNavigationStore((s) => s.toggleVoice);
  const toggleKeepScreenOn = useNavigationStore((s) => s.toggleKeepScreenOn);

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
        <Stack spacing={2}>
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

          <FormControlLabel
            control={<Switch checked={voiceEnabled} onChange={() => toggleVoice()} />}
            label={
              <Stack spacing={0.5}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t("voiceGuidance")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {t("voiceGuidanceDescription")}
                </Typography>
              </Stack>
            }
            sx={{ alignItems: "flex-start", m: 0 }}
          />

          <FormControlLabel
            control={<Switch checked={keepScreenOn} onChange={() => toggleKeepScreenOn()} />}
            label={
              <Stack spacing={0.5}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t("keepScreenOn")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {t("keepScreenOnDescription")}
                </Typography>
              </Stack>
            }
            sx={{ alignItems: "flex-start", m: 0 }}
          />
        </Stack>
      </Paper>
    </Stack>
  );
}

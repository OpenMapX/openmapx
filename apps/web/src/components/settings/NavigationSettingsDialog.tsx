"use client";

import CloseIcon from "@mui/icons-material/Close";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import {
  useDirectionsStore,
  useNavigationStore,
  useSettingsStore,
  type VoiceGuidanceTiming,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { speakOnce, useAvailableVoices } from "@/lib/navigation/useNavigationVoice";
import { Section, SettingRow, SwitchControl } from "./settingsPrimitives";

const VOICE_TIMING_OPTIONS: { value: VoiceGuidanceTiming; labelKey: string }[] = [
  { value: "early", labelKey: "voiceTimingEarly" },
  { value: "normal", labelKey: "voiceTimingNormal" },
  { value: "late", labelKey: "voiceTimingLate" },
];

export function NavigationSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const tn = useTranslations("navigationSettings");
  const ts = useTranslations("settings");
  const tnav = useTranslations("navigation");
  const tc = useTranslations("common");
  const locale = useLocale();
  const fullScreen = useFullScreenOnMobile();
  const voices = useAvailableVoices();

  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const { toggleVoice, toggleKeepScreenOn } = useNavigationMutations();
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);

  const voiceGuidanceTiming = useSettingsStore((s) => s.voiceGuidanceTiming);
  const setVoiceGuidanceTiming = useSettingsStore((s) => s.setVoiceGuidanceTiming);
  const voiceName = useSettingsStore((s) => s.voiceName);
  const setVoiceName = useSettingsStore((s) => s.setVoiceName);
  const speedCameraAlerts = useSettingsStore((s) => s.speedCameraAlerts);
  const setSpeedCameraAlerts = useSettingsStore((s) => s.setSpeedCameraAlerts);
  const incidentAlerts = useSettingsStore((s) => s.incidentAlerts);
  const setIncidentAlerts = useSettingsStore((s) => s.setIncidentAlerts);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const setAvoidIncidents = useSettingsStore((s) => s.setAvoidIncidents);
  const fasterRoutes = useSettingsStore((s) => s.fasterRoutes);
  const setFasterRoutes = useSettingsStore((s) => s.setFasterRoutes);
  const autoSwitchFasterRoutes = useSettingsStore((s) => s.autoSwitchFasterRoutes);
  const setAutoSwitchFasterRoutes = useSettingsStore((s) => s.setAutoSwitchFasterRoutes);
  const mapNorthUp = useSettingsStore((s) => s.mapNorthUp);
  const setMapNorthUp = useSettingsStore((s) => s.setMapNorthUp);

  const avoidHighways = useDirectionsStore((s) => s.avoidHighways);
  const setAvoidHighways = useDirectionsStore((s) => s.setAvoidHighways);
  const avoidTolls = useDirectionsStore((s) => s.avoidTolls);
  const setAvoidTolls = useDirectionsStore((s) => s.setAvoidTolls);
  const avoidFerries = useDirectionsStore((s) => s.avoidFerries);
  const setAvoidFerries = useDirectionsStore((s) => s.setAvoidFerries);

  const hint = (text: string) => (
    <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
      {text}
    </Typography>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {tn("title")}
        <IconButton onClick={onClose} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Section title={tn("sectionVoice")}>
          <SettingRow label={tn("voiceGuidance")}>
            <SwitchControl checked={voiceEnabled} onChange={() => void toggleVoice()} />
          </SettingRow>
          <SettingRow label={ts("voiceGuidanceTiming")}>
            <Select
              size="small"
              fullWidth
              value={voiceGuidanceTiming}
              onChange={(e) => setVoiceGuidanceTiming(e.target.value as VoiceGuidanceTiming)}
            >
              {VOICE_TIMING_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {ts(o.labelKey)}
                </MenuItem>
              ))}
            </Select>
          </SettingRow>
          <SettingRow label={tn("voice")}>
            <Select
              size="small"
              fullWidth
              value={voiceName ?? ""}
              onChange={(e) => setVoiceName(e.target.value || null)}
            >
              <MenuItem value="">{tn("voiceDefault")}</MenuItem>
              {voices.map((v) => (
                <MenuItem key={v.name} value={v.name}>
                  {`${v.name} (${v.lang})`}
                </MenuItem>
              ))}
            </Select>
          </SettingRow>
          <Button
            size="small"
            variant="outlined"
            sx={{ mt: 0.5 }}
            onClick={() => speakOnce(tn("voiceTestSample"), locale, voiceName)}
          >
            {tn("voiceTest")}
          </Button>
        </Section>

        <Section title={tn("sectionAlerts")}>
          <SettingRow label={ts("incidentAlerts")}>
            <SwitchControl checked={incidentAlerts} onChange={setIncidentAlerts} />
          </SettingRow>
          {hint(ts("incidentAlertsHint"))}
          <SettingRow label={ts("speedCameraAlerts")}>
            <SwitchControl checked={speedCameraAlerts} onChange={setSpeedCameraAlerts} />
          </SettingRow>
          {hint(ts("speedCameraAlertsHint"))}
        </Section>

        <Section title={tn("sectionRouting")}>
          <SettingRow label={tn("avoidClosures")}>
            <SwitchControl checked={avoidIncidents} onChange={setAvoidIncidents} />
          </SettingRow>
          <SettingRow label={tn("fasterRoutes")}>
            <SwitchControl checked={fasterRoutes} onChange={setFasterRoutes} />
          </SettingRow>
          {hint(tn("fasterRoutesHint"))}
          <SettingRow label={tn("autoSwitchFasterRoutes")}>
            <SwitchControl checked={autoSwitchFasterRoutes} onChange={setAutoSwitchFasterRoutes} />
          </SettingRow>
          {hint(tn("autoSwitchFasterRoutesHint"))}
          <SettingRow label={tn("avoidMotorways")}>
            <SwitchControl checked={avoidHighways} onChange={setAvoidHighways} />
          </SettingRow>
          <SettingRow label={tn("avoidTolls")}>
            <SwitchControl checked={avoidTolls} onChange={setAvoidTolls} />
          </SettingRow>
          <SettingRow label={tn("avoidFerries")}>
            <SwitchControl checked={avoidFerries} onChange={setAvoidFerries} />
          </SettingRow>
        </Section>

        <Section title={tn("sectionDuringNav")}>
          <SettingRow label={tn("mapNorthUp")}>
            <SwitchControl checked={mapNorthUp} onChange={setMapNorthUp} />
          </SettingRow>
          <SettingRow label={tnav("keepScreenOn")}>
            <SwitchControl checked={keepScreenOn} onChange={() => void toggleKeepScreenOn()} />
          </SettingRow>
        </Section>
      </DialogContent>
    </Dialog>
  );
}

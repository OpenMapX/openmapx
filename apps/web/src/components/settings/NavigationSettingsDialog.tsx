"use client";

import CloseIcon from "@mui/icons-material/Close";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import { useDirectionsStore, useNavigationStore, useSettingsStore } from "@openmapx/core";
import type { VoiceTiming } from "@openmapx/core/navigation";
import { useLocale, useTranslations } from "next-intl";
import Dialog from "@/components/ui/Dialog";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { speakOnce, useAvailableVoices } from "@/lib/navigation/useNavigationVoice";
import { ActionRow, ChoiceRow, Section, SwitchRow } from "./settingsPrimitives";

const VOICE_TIMING_OPTIONS: { value: VoiceTiming; labelKey: string }[] = [
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
  const { toggleVoice, toggleKeepScreenOn, setVoiceTiming } = useNavigationMutations();
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);

  const voiceGuidanceTiming = useSettingsStore((s) => s.voiceGuidanceTiming);
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
      <DialogContent dividers sx={{ px: 0, pt: 0 }}>
        <Section title={tn("sectionVoice")}>
          <SwitchRow
            label={tn("voiceGuidance")}
            checked={voiceEnabled}
            onChange={() => void toggleVoice()}
          />
          <ChoiceRow
            label={ts("voiceGuidanceTiming")}
            value={voiceGuidanceTiming}
            choices={VOICE_TIMING_OPTIONS.map((o) => ({ value: o.value, label: ts(o.labelKey) }))}
            onChange={(next) => void setVoiceTiming(next)}
          />
          <ChoiceRow
            label={tn("voice")}
            value={voiceName ?? ""}
            choices={[
              { value: "", label: tn("voiceDefault") },
              ...voices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` })),
            ]}
            onChange={(next) => setVoiceName(next || null)}
          />
          <ActionRow
            label={tn("voiceTest")}
            onClick={() => speakOnce(tn("voiceTestSample"), locale, voiceName)}
          />
        </Section>

        <Section title={tn("sectionAlerts")}>
          <SwitchRow
            label={ts("incidentAlerts")}
            description={ts("incidentAlertsHint")}
            checked={incidentAlerts}
            onChange={setIncidentAlerts}
          />
          <SwitchRow
            label={ts("speedCameraAlerts")}
            description={ts("speedCameraAlertsHint")}
            checked={speedCameraAlerts}
            onChange={setSpeedCameraAlerts}
          />
        </Section>

        <Section title={tn("sectionRouting")}>
          <SwitchRow
            label={tn("avoidClosures")}
            checked={avoidIncidents}
            onChange={setAvoidIncidents}
          />
          <SwitchRow
            label={tn("fasterRoutes")}
            description={tn("fasterRoutesHint")}
            checked={fasterRoutes}
            onChange={setFasterRoutes}
          />
          <SwitchRow
            label={tn("autoSwitchFasterRoutes")}
            description={tn("autoSwitchFasterRoutesHint")}
            checked={autoSwitchFasterRoutes}
            onChange={setAutoSwitchFasterRoutes}
          />
          <SwitchRow
            label={tn("avoidMotorways")}
            checked={avoidHighways}
            onChange={setAvoidHighways}
          />
          <SwitchRow label={tn("avoidTolls")} checked={avoidTolls} onChange={setAvoidTolls} />
          <SwitchRow label={tn("avoidFerries")} checked={avoidFerries} onChange={setAvoidFerries} />
        </Section>

        <Section title={tn("sectionDuringNav")}>
          <SwitchRow label={tn("mapNorthUp")} checked={mapNorthUp} onChange={setMapNorthUp} />
          <SwitchRow
            label={tnav("keepScreenOn")}
            checked={keepScreenOn}
            onChange={() => void toggleKeepScreenOn()}
          />
        </Section>
      </DialogContent>
    </Dialog>
  );
}

import type { ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { BUTTON_SHAPE, useNativePalette } from "./nativeTheme";
import { actionsFor, type ShellAction, type ShellState } from "./ShellState";
import { type ShellCopyKey, shellCopy } from "./shellCopy";
import { SCROLL_SAFE_AREA, topBarInset } from "./systemBars";

/**
 * The native explanation for the states the page cannot render itself.
 *
 * Every one of these is a moment where the user needs to know what is still
 * happening — guidance running behind a dead page, tracking stopped by a
 * force-stop, permission removed underneath a trip. None of them is an
 * opportunity to build a second map: the buttons come from `ShellState`, so a
 * state cannot quietly grow a navigation control.
 *
 * Text scales with the system font and every control is a labelled button,
 * because these screens appear exactly when the user is least able to read
 * carefully.
 */

const styles = StyleSheet.create({
  fill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  content: { padding: 24, paddingBottom: 40, flexGrow: 1, justifyContent: "center" },
  title: { fontSize: 21, fontWeight: "600", marginBottom: 12 },
  body: { fontSize: 16, lineHeight: 23, marginBottom: 24 },
  primary: {
    minHeight: 48,
    borderRadius: BUTTON_SHAPE.borderRadius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginBottom: 12,
  },
  primaryLabel: { fontSize: 16, fontWeight: BUTTON_SHAPE.labelWeight },
  secondary: {
    minHeight: 48,
    borderRadius: BUTTON_SHAPE.borderRadius,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginBottom: 12,
  },
  secondaryLabel: { fontSize: 16, fontWeight: BUTTON_SHAPE.labelWeight },
});

const COPY: Partial<Record<ShellState["kind"], { title: ShellCopyKey; body: ShellCopyKey }>> = {
  "load-error": { title: "loadErrorTitle", body: "loadErrorBody" },
  "offline-navigating": { title: "offlineNavigatingTitle", body: "offlineNavigatingBody" },
  "incompatible-shell": { title: "incompatibleTitle", body: "incompatibleBody" },
  "corrupt-session": { title: "corruptSessionTitle", body: "corruptSessionBody" },
  "permission-lost": { title: "permissionLostTitle", body: "permissionLostBody" },
  "resume-offer": { title: "resumeTitle", body: "resumeBody" },
  "fatal-config": { title: "fatalConfigTitle", body: "fatalConfigBody" },
};

const ACTION_LABELS: Record<ShellAction, ShellCopyKey> = {
  retry: "retry",
  "open-network-settings": "openNetworkSettings",
  resume: "resume",
  end: "end",
  dismiss: "dismiss",
  "open-app-settings": "openAppSettings",
};

/** The first action is the one the user most likely wants; the rest are equals. */
const TEST_IDS: Record<ShellAction, string> = {
  retry: "shell-action-retry",
  "open-network-settings": "shell-action-network-settings",
  resume: "shell-action-resume",
  end: "shell-action-end",
  dismiss: "shell-action-dismiss",
  "open-app-settings": "shell-action-app-settings",
};

export interface NativeRecoveryOverlayProps {
  locale: MobileLocale;
  state: ShellState;
  onAction: (action: ShellAction) => void;
}

export function NativeRecoveryOverlay({
  locale,
  state,
  onAction,
}: NativeRecoveryOverlayProps): ReactElement | null {
  const palette = useNativePalette();
  const copy = COPY[state.kind];
  // `loading` and `web` have nothing to say, and saying nothing is the point.
  if (!copy) return null;

  const actions = actionsFor(state);
  const offlineHint =
    state.kind === "load-error" && state.offline
      ? shellCopy(locale, "offlineBody")
      : shellCopy(locale, copy.body);

  return (
    <View
      style={[styles.fill, { backgroundColor: palette.background }]}
      testID={`shell-state-${state.kind}`}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 24 + topBarInset() }]}
        {...SCROLL_SAFE_AREA}
      >
        <Text accessibilityRole="header" style={[styles.title, { color: palette.title }]}>
          {shellCopy(
            locale,
            state.kind === "load-error" && state.offline ? "offlineTitle" : copy.title,
          )}
        </Text>
        <Text style={[styles.body, { color: palette.body }]}>{offlineHint}</Text>
        {actions.map((action, index) => (
          <Pressable
            key={action}
            accessibilityRole="button"
            accessibilityLabel={shellCopy(locale, ACTION_LABELS[action])}
            onPress={() => onAction(action)}
            style={
              index === 0
                ? [styles.primary, { backgroundColor: palette.accent }]
                : [styles.secondary, { borderColor: palette.outline }]
            }
            testID={TEST_IDS[action]}
          >
            <Text
              style={
                index === 0
                  ? [styles.primaryLabel, { color: palette.onAccent }]
                  : [styles.secondaryLabel, { color: palette.secondaryLabel }]
              }
            >
              {shellCopy(locale, ACTION_LABELS[action])}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

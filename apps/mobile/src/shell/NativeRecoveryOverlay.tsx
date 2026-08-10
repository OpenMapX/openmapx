import type { ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { actionsFor, type ShellAction, type ShellState } from "./ShellState";
import { type ShellCopyKey, shellCopy } from "./shellCopy";

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
    backgroundColor: "#FFFFFF",
  },
  content: { padding: 24, paddingBottom: 40, flexGrow: 1, justifyContent: "center" },
  title: { fontSize: 21, fontWeight: "600", marginBottom: 12, color: "#101418" },
  body: { fontSize: 16, lineHeight: 23, marginBottom: 24, color: "#3C4650" },
  primary: {
    minHeight: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#1B69D6",
    marginBottom: 12,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  secondary: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#C3CBD3",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginBottom: 12,
  },
  secondaryLabel: { color: "#1B3A5C", fontSize: 16, fontWeight: "600" },
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
  const copy = COPY[state.kind];
  // `loading` and `web` have nothing to say, and saying nothing is the point.
  if (!copy) return null;

  const actions = actionsFor(state);
  const offlineHint =
    state.kind === "load-error" && state.offline
      ? shellCopy(locale, "offlineBody")
      : shellCopy(locale, copy.body);

  return (
    <View style={styles.fill} testID={`shell-state-${state.kind}`}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {shellCopy(
            locale,
            state.kind === "load-error" && state.offline ? "offlineTitle" : copy.title,
          )}
        </Text>
        <Text style={styles.body}>{offlineHint}</Text>
        {actions.map((action, index) => (
          <Pressable
            key={action}
            accessibilityRole="button"
            accessibilityLabel={shellCopy(locale, ACTION_LABELS[action])}
            onPress={() => onAction(action)}
            style={index === 0 ? styles.primary : styles.secondary}
            testID={TEST_IDS[action]}
          >
            <Text style={index === 0 ? styles.primaryLabel : styles.secondaryLabel}>
              {shellCopy(locale, ACTION_LABELS[action])}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

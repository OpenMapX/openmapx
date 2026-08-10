import type { ReactElement } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { permissionCopy } from "./permissionCopy";
import type { PermissionFlowState } from "./permissionMachine";

/**
 * The native explanation shown before any operating-system prompt.
 *
 * It has to be native rather than web: on the platform screens that follow, and
 * on a device whose page is suspended, there may be no document to render it.
 * It states what is collected, where it is processed, what leaves the device,
 * how to stop it, and what the limited mode actually costs — before the user is
 * asked, not after.
 *
 * The text scales with the system font and every control is a real button with
 * a label, because a permission screen that a screen reader cannot narrate is a
 * permission screen the user did not consent to.
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
  content: { padding: 24, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "600", marginBottom: 16, color: "#101418" },
  paragraph: { fontSize: 16, lineHeight: 23, marginBottom: 12, color: "#3C4650" },
  actions: { marginTop: 12 },
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

export interface PermissionDisclosureProps {
  locale: MobileLocale;
  onAccept: () => void;
  onForegroundOnly: () => void;
  onDismiss: () => void;
}

export function PermissionDisclosure({
  locale,
  onAccept,
  onForegroundOnly,
  onDismiss,
}: PermissionDisclosureProps): ReactElement {
  const text = (key: Parameters<typeof permissionCopy>[1]) => permissionCopy(locale, key);
  return (
    <View style={styles.fill} testID="permission-disclosure">
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {text("title")}
        </Text>
        <Text style={styles.paragraph}>{text("purpose")}</Text>
        <Text style={styles.paragraph}>{text("precise")}</Text>
        <Text style={styles.paragraph}>{text("processing")}</Text>
        <Text style={styles.paragraph}>{text("transmission")}</Text>
        <Text style={styles.paragraph}>{text("stopping")}</Text>
        <Text style={styles.paragraph}>{text("foregroundOnlyNote")}</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("continue")}
            onPress={onAccept}
            style={styles.primary}
            testID="permission-continue"
          >
            <Text style={styles.primaryLabel}>{text("continue")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("foregroundOnly")}
            onPress={onForegroundOnly}
            style={styles.secondary}
            testID="permission-foreground-only"
          >
            <Text style={styles.secondaryLabel}>{text("foregroundOnly")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("notNow")}
            onPress={onDismiss}
            style={styles.secondary}
            testID="permission-not-now"
          >
            <Text style={styles.secondaryLabel}>{text("notNow")}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

export interface PermissionOutcomeProps {
  locale: MobileLocale;
  state: PermissionFlowState;
  onOpenSettings: () => void;
  onDismiss: () => void;
}

/**
 * What follows a decision: the settings route, or a plain statement that
 * navigation is unavailable. Neither ever reopens a prompt by itself.
 */
export function PermissionOutcome({
  locale,
  state,
  onOpenSettings,
  onDismiss,
}: PermissionOutcomeProps): ReactElement | null {
  const text = (key: Parameters<typeof permissionCopy>[1]) => permissionCopy(locale, key);

  if (state.state === "settings-required") {
    const body =
      state.reason === "precise-required"
        ? text("settingsPrecise")
        : state.reason === "background-in-settings"
          ? text("settingsBackground")
          : text("settingsCannotEscalate");
    return (
      <View style={styles.fill} testID="permission-settings-required">
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>
            {text("settingsTitle")}
          </Text>
          <Text style={styles.paragraph}>{body}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("openSettings")}
              onPress={onOpenSettings}
              style={styles.primary}
              testID="permission-open-settings"
            >
              <Text style={styles.primaryLabel}>{text("openSettings")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("notNow")}
              onPress={onDismiss}
              style={styles.secondary}
              testID="permission-settings-dismiss"
            >
              <Text style={styles.secondaryLabel}>{text("notNow")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (state.state === "denied") {
    return (
      <View style={styles.fill} testID="permission-denied">
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>
            {text("deniedTitle")}
          </Text>
          <Text style={styles.paragraph}>{text("deniedBody")}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("notNow")}
              onPress={onDismiss}
              style={styles.secondary}
              testID="permission-denied-dismiss"
            >
              <Text style={styles.secondaryLabel}>{text("notNow")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  return null;
}

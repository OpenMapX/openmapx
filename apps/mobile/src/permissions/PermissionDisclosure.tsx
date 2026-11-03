import { type ReactElement, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { BUTTON_SHAPE, useNativePalette } from "../shell/nativeTheme";
import { SCROLL_SAFE_AREA, topBarInset } from "../shell/systemBars";
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
  },
  content: { padding: 24, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "600", marginBottom: 16 },
  paragraph: { fontSize: 16, lineHeight: 23, marginBottom: 12 },
  actions: { marginTop: 12 },
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

/** The static layout above, coloured for the current system appearance. */
function useDisclosureStyles() {
  const palette = useNativePalette();
  return useMemo(
    () => ({
      fill: [styles.fill, { backgroundColor: palette.background }],
      content: styles.content,
      title: [styles.title, { color: palette.title }],
      paragraph: [styles.paragraph, { color: palette.body }],
      actions: styles.actions,
      primary: [styles.primary, { backgroundColor: palette.accent }],
      primaryLabel: [styles.primaryLabel, { color: palette.onAccent }],
      secondary: [styles.secondary, { borderColor: palette.outline }],
      secondaryLabel: [styles.secondaryLabel, { color: palette.secondaryLabel }],
    }),
    [palette],
  );
}

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
  const s = useDisclosureStyles();
  const text = (key: Parameters<typeof permissionCopy>[1]) => permissionCopy(locale, key);
  return (
    <View style={s.fill} testID="permission-disclosure">
      <ScrollView
        contentContainerStyle={[s.content, { paddingTop: 24 + topBarInset() }]}
        {...SCROLL_SAFE_AREA}
      >
        <Text accessibilityRole="header" style={s.title}>
          {text("title")}
        </Text>
        <Text style={s.paragraph}>{text("purpose")}</Text>
        <Text style={s.paragraph}>{text("precise")}</Text>
        <Text style={s.paragraph}>{text("processing")}</Text>
        <Text style={s.paragraph}>{text("transmission")}</Text>
        <Text style={s.paragraph}>{text("stopping")}</Text>
        <Text style={s.paragraph}>{text("foregroundOnlyNote")}</Text>
        <View style={s.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("continue")}
            onPress={onAccept}
            style={s.primary}
            testID="permission-continue"
          >
            <Text style={s.primaryLabel}>{text("continue")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("foregroundOnly")}
            onPress={onForegroundOnly}
            style={s.secondary}
            testID="permission-foreground-only"
          >
            <Text style={s.secondaryLabel}>{text("foregroundOnly")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={text("notNow")}
            onPress={onDismiss}
            style={s.secondary}
            testID="permission-not-now"
          >
            <Text style={s.secondaryLabel}>{text("notNow")}</Text>
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
  const s = useDisclosureStyles();
  const text = (key: Parameters<typeof permissionCopy>[1]) => permissionCopy(locale, key);

  if (state.state === "settings-required") {
    const body =
      state.reason === "precise-required"
        ? text("settingsPrecise")
        : state.reason === "background-in-settings"
          ? text("settingsBackground")
          : text("settingsCannotEscalate");
    return (
      <View style={s.fill} testID="permission-settings-required">
        <ScrollView
          contentContainerStyle={[s.content, { paddingTop: 24 + topBarInset() }]}
          {...SCROLL_SAFE_AREA}
        >
          <Text accessibilityRole="header" style={s.title}>
            {text("settingsTitle")}
          </Text>
          <Text style={s.paragraph}>{body}</Text>
          <View style={s.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("openSettings")}
              onPress={onOpenSettings}
              style={s.primary}
              testID="permission-open-settings"
            >
              <Text style={s.primaryLabel}>{text("openSettings")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("notNow")}
              onPress={onDismiss}
              style={s.secondary}
              testID="permission-settings-dismiss"
            >
              <Text style={s.secondaryLabel}>{text("notNow")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (state.state === "denied") {
    return (
      <View style={s.fill} testID="permission-denied">
        <ScrollView
          contentContainerStyle={[s.content, { paddingTop: 24 + topBarInset() }]}
          {...SCROLL_SAFE_AREA}
        >
          <Text accessibilityRole="header" style={s.title}>
            {text("deniedTitle")}
          </Text>
          <Text style={s.paragraph}>{text("deniedBody")}</Text>
          <View style={s.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={text("notNow")}
              onPress={onDismiss}
              style={s.secondary}
              testID="permission-denied-dismiss"
            >
              <Text style={s.secondaryLabel}>{text("notNow")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  return null;
}

import type { ReactElement } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { shellCopy } from "./shellCopy";

/**
 * The only native UI this app has: a spinner while the product loads, and a
 * readable error state for the cases where the WebView cannot render at all.
 *
 * These deliberately do not grow into a second map or route planner. Their job
 * is to explain the situation and offer the few actions that remain safe.
 */

const styles = StyleSheet.create({
  fill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#FFFFFF",
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 8,
    color: "#101418",
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
    marginBottom: 24,
    color: "#3C4650",
  },
  button: {
    minHeight: 48,
    minWidth: 160,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1B69D6",
  },
  buttonLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  loadingLabel: { marginTop: 16, fontSize: 16, color: "#3C4650" },
});

export function LoadingOverlay({ locale }: { locale: MobileLocale }): ReactElement {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={shellCopy(locale, "loading")}
      style={styles.fill}
      testID="shell-loading"
    >
      <ActivityIndicator size="large" color="#1B69D6" />
      <Text style={styles.loadingLabel}>{shellCopy(locale, "loading")}</Text>
    </View>
  );
}

export interface ShellMessageOverlayProps {
  locale: MobileLocale;
  testID: string;
  title: string;
  body: string;
  /** Omitted for unrecoverable states, where offering a button would mislead. */
  action?: { label: string; onPress: () => void; testID: string };
}

export function ShellMessageOverlay({
  testID,
  title,
  body,
  action,
}: ShellMessageOverlayProps): ReactElement {
  return (
    <View style={styles.fill} testID={testID}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.body}>{body}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={styles.button}
          testID={action.testID}
        >
          <Text style={styles.buttonLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Appbar, useTheme } from "react-native-paper";
import WebView from "react-native-webview";

const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? "https://openmapx.com";

const TITLE_KEYS: Record<string, string> = {
  privacy: "menu.privacy",
  terms: "menu.terms",
  imprint: "menu.imprint",
};

export default function LegalPage() {
  const { page } = useLocalSearchParams<{ page: string }>();
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const titleKey = TITLE_KEYS[page] ?? "menu.imprint";
  const url = `${WEB_BASE_URL}/${page}`;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={handleBack} />
        <Appbar.Content title={t(titleKey)} />
      </Appbar.Header>
      <WebView source={{ uri: url }} style={styles.webview} startInLoadingState />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});

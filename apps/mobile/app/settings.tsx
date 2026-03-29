import { MaterialIcons } from "@expo/vector-icons";
import { useSession } from "@openmapx/core";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Divider, List, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function SettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: session } = useSession();
  const appVersion = Constants.expoConfig?.version ?? "0.1.0";

  const user = session?.user;

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={handleBack} />
        <Appbar.Content title={t("settings.title")} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 16 }]}>
        {/* Account section */}
        {user && (
          <>
            <List.Section>
              <List.Subheader>{t("account.profile")}</List.Subheader>
              <List.Item
                title={user.name ?? user.email}
                description={user.name ? user.email : undefined}
                left={(props) => (
                  <List.Icon
                    {...props}
                    icon={({ size, color }) => (
                      <MaterialIcons name="account-circle" size={size} color={color} />
                    )}
                  />
                )}
              />
            </List.Section>
            <Divider />
          </>
        )}

        {/* About */}
        <List.Section>
          <List.Subheader>{t("settings.about")}</List.Subheader>
          <List.Item
            title="OpenMapX"
            description={t("settings.openSource")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="info-outline" size={size} color={color} />
                )}
              />
            )}
          />
          <List.Item
            title={t("settings.version")}
            description={appVersion}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => <MaterialIcons name="tag" size={size} color={color} />}
              />
            )}
          />
        </List.Section>

        <Divider />

        {/* Legal */}
        <List.Section>
          <List.Subheader>{t("settings.legal")}</List.Subheader>
          <List.Item
            title={t("menu.privacy")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="privacy-tip" size={size} color={color} />
                )}
              />
            )}
            onPress={() => router.push("/legal/privacy")}
          />
          <List.Item
            title={t("menu.terms")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="description" size={size} color={color} />
                )}
              />
            )}
            onPress={() => router.push("/legal/terms")}
          />
          <List.Item
            title={t("menu.imprint")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => <MaterialIcons name="gavel" size={size} color={color} />}
              />
            )}
            onPress={() => router.push("/legal/imprint")}
          />
        </List.Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
  },
});

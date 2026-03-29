import { MaterialIcons } from "@expo/vector-icons";
import type { User } from "@openmapx/core";
import { authClient, getInitials } from "@openmapx/core";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Avatar, Divider, List, Text, useTheme } from "react-native-paper";
import { AccountSettingsDialog } from "./AccountSettingsDialog";
import { AuthDialog } from "./AuthDialog";

interface AccountMenuProps {
  user: User | undefined;
  onClose: () => void;
}

export function AccountMenu({ user, onClose }: AccountMenuProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [authVisible, setAuthVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const handleSignIn = useCallback(() => {
    onClose();
    setAuthVisible(true);
  }, [onClose]);

  const handleSignOut = useCallback(async () => {
    onClose();
    await authClient.signOut();
  }, [onClose]);

  const handleSettings = useCallback(() => {
    onClose();
    setSettingsVisible(true);
  }, [onClose]);

  if (!user) {
    return (
      <>
        <List.Item
          title={t("settings.signIn")}
          left={(props) => (
            <List.Icon
              {...props}
              icon={({ size, color }) => (
                <MaterialIcons name="person-outline" size={size} color={color} />
              )}
            />
          )}
          onPress={handleSignIn}
        />
        <AuthDialog visible={authVisible} onDismiss={() => setAuthVisible(false)} />
      </>
    );
  }

  const initials = getInitials(user.name, user.email);

  return (
    <>
      {/* User info */}
      <View style={styles.userHeader}>
        {user.image ? (
          <Avatar.Image size={40} source={{ uri: user.image }} />
        ) : (
          <Avatar.Text
            size={40}
            label={initials}
            style={{ backgroundColor: theme.colors.primary }}
          />
        )}
        <View style={styles.userInfo}>
          <Text variant="bodyLarge" style={styles.userName} numberOfLines={1}>
            {user.name}
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant }}
            numberOfLines={1}
          >
            {user.email}
          </Text>
        </View>
      </View>

      <Divider />

      {/* Account settings */}
      <List.Item
        title={t("account.accountSettings")}
        left={(props) => (
          <List.Icon
            {...props}
            icon={({ size, color }) => <MaterialIcons name="settings" size={size} color={color} />}
          />
        )}
        onPress={handleSettings}
      />

      {/* Sign out */}
      <List.Item
        title={t("account.signOut")}
        left={(props) => (
          <List.Icon
            {...props}
            icon={({ size, color }) => <MaterialIcons name="logout" size={size} color={color} />}
          />
        )}
        onPress={handleSignOut}
      />

      <AuthDialog visible={authVisible} onDismiss={() => setAuthVisible(false)} />
      <AccountSettingsDialog
        visible={settingsVisible}
        onDismiss={() => setSettingsVisible(false)}
        user={user}
      />
    </>
  );
}

const styles = StyleSheet.create({
  userHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  userInfo: {
    flex: 1,
    minWidth: 0,
  },
  userName: {
    fontWeight: "600",
  },
});

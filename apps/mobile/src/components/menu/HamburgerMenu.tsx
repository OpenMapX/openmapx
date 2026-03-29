import { MaterialIcons } from "@expo/vector-icons";
import BottomSheet, {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { useMenuStore, useSession } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Divider, List, Text, useTheme } from "react-native-paper";
import { AccountMenu } from "../auth/AccountMenu";
import { LanguageMenu } from "./LanguageMenu";

export function HamburgerMenu() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const isOpen = useMenuStore((s) => s.isOpen);
  const close = useMenuStore((s) => s.close);
  const sheetRef = useRef<BottomSheet>(null);
  const [langVisible, setLangVisible] = useState(false);
  const { data: session } = useSession();

  const snapPoints = useMemo(() => ["60%", "90%"], []);

  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  const handleSettings = useCallback(() => {
    close();
    router.push("/settings");
  }, [close, router]);

  const handleSaved = useCallback(() => {
    close();
    router.push("/saved");
  }, [close, router]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={0.3}
      />
    ),
    [],
  );

  const user = session?.user;

  return (
    <>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        onClose={handleClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: theme.colors.surface }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.onSurfaceVariant }}
        containerStyle={{ zIndex: 20 }}
      >
        <BottomSheetScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <Text variant="headlineSmall" style={styles.headerTitle}>
              OpenMapX
            </Text>
          </View>

          <Divider />

          {/* User section */}
          <AccountMenu user={user ?? undefined} onClose={handleClose} />

          <Divider />

          {/* Navigation items */}
          <List.Item
            title={t("menu.saved")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="bookmark-border" size={size} color={color} />
                )}
              />
            )}
            onPress={handleSaved}
          />

          <List.Item
            title={t("settings.title")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="settings" size={size} color={color} />
                )}
              />
            )}
            onPress={handleSettings}
          />

          <Divider />

          {/* Language */}
          <List.Item
            title={t("menu.language")}
            left={(props) => (
              <List.Icon
                {...props}
                icon={({ size, color }) => (
                  <MaterialIcons name="translate" size={size} color={color} />
                )}
              />
            )}
            onPress={() => setLangVisible(true)}
          />

          <Divider />

          {/* Legal */}
          <List.Item
            title={t("menu.privacy")}
            onPress={() => {
              close();
              router.push("/legal/privacy");
            }}
          />
          <List.Item
            title={t("menu.terms")}
            onPress={() => {
              close();
              router.push("/legal/terms");
            }}
          />
          <List.Item
            title={t("menu.imprint")}
            onPress={() => {
              close();
              router.push("/legal/imprint");
            }}
          />
        </BottomSheetScrollView>
      </BottomSheet>

      <LanguageMenu visible={langVisible} onDismiss={() => setLangVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontWeight: "600",
  },
});

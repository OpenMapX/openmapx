import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, useColorScheme, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

const SEP = " \u00B7 ";

export function MapFooter() {
  const { t } = useTranslation();
  const theme = useTheme();
  const isDark = useColorScheme() === "dark";
  const color = theme.colors.onSurfaceVariant;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: isDark ? "rgba(0, 0, 0, 0.7)" : "rgba(255, 255, 255, 0.7)" },
      ]}
    >
      <Text variant="labelSmall" style={[styles.text, { color }]}>
        OpenMapX
      </Text>
      <Text variant="labelSmall" style={[styles.separator, { color }]}>
        {SEP}
      </Text>
      <Text
        variant="labelSmall"
        style={[styles.link, { color }]}
        onPress={() => Linking.openURL("https://www.openstreetmap.org/copyright")}
      >
        {"\u00A9 OpenStreetMap"}
      </Text>
      <Text variant="labelSmall" style={[styles.separator, { color }]}>
        {SEP}
      </Text>
      <Text
        variant="labelSmall"
        style={[styles.link, { color }]}
        onPress={() => Linking.openURL("https://openmapx.com/imprint")}
      >
        {t("menu.imprint")}
      </Text>
      <Text variant="labelSmall" style={[styles.separator, { color }]}>
        {SEP}
      </Text>
      <Text
        variant="labelSmall"
        style={[styles.link, { color }]}
        onPress={() => Linking.openURL("https://openmapx.com/privacy")}
      >
        {t("menu.privacy")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 4,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  text: {
    fontSize: 10,
    lineHeight: 14,
  },
  separator: {
    fontSize: 10,
    lineHeight: 14,
  },
  link: {
    fontSize: 10,
    lineHeight: 14,
    textDecorationLine: "underline",
  },
});

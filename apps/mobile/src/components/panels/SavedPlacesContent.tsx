import { useSavedPlacesStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { SegmentedButtons } from "react-native-paper";
import { SavedLabeledTab } from "./SavedLabeledTab";
import { SavedListsTab } from "./SavedListsTab";

export function SavedPlacesContent() {
  const { t } = useTranslation();
  const activeTab = useSavedPlacesStore((s) => s.activeTab);
  const setActiveTab = useSavedPlacesStore((s) => s.setActiveTab);

  return (
    <View style={styles.container}>
      <View style={styles.segmentContainer}>
        <SegmentedButtons
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "lists" | "labeled")}
          buttons={[
            { value: "lists", label: t("saved.lists") },
            { value: "labeled", label: t("saved.labeled") },
          ]}
          density="medium"
        />
      </View>

      {activeTab === "lists" ? <SavedListsTab /> : <SavedLabeledTab />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  segmentContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});

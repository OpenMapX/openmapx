import { MaterialIcons } from "@expo/vector-icons";
import type { Place } from "@openmapx/core";
import { useDirectionsStore, useIsSaved, usePlaceStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { SavePlaceDialog } from "./SavePlaceDialog";

const TEAL = "#007b8b";
const TEAL_LIGHT = "#e0f2f4";

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  filled?: boolean;
  onPress?: () => void;
}

function ActionButton({ icon, label, filled = false, onPress }: ActionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.actionButtonContainer}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.actionButtonCircle, { backgroundColor: filled ? TEAL : TEAL_LIGHT }]}>
        {icon}
      </View>
      <Text style={[styles.actionButtonLabel, { color: TEAL }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface Props {
  place: Place;
}

export function PlaceActionButtons({ place }: Props) {
  const { t } = useTranslation();
  const router = useRouter();
  const { setDestination, open: openDirections } = useDirectionsStore();
  const { setSelectedPlace } = usePlaceStore();
  const { data: savedInListIds } = useIsSaved(place.id);
  const isSaved = savedInListIds && savedInListIds.length > 0;
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const handleDirections = () => {
    setDestination(place.coordinates, place.name);
    openDirections();
    setSelectedPlace(null);
    router.push("/directions");
  };

  const handleCall = () => {
    if (place.phone) {
      Linking.openURL(`tel:${place.phone}`);
    }
  };

  const handleWebsite = () => {
    if (place.website) {
      Linking.openURL(place.website);
    }
  };

  const handleShare = async () => {
    const [lng, lat] = place.coordinates;
    const params = new URLSearchParams({
      place: place.id,
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      name: place.name,
    });
    if (place.category) params.set("category", place.category);
    if (place.rawCategory) params.set("rawCategory", place.rawCategory);
    const url = `https://openmapx.com/?${params.toString()}`;
    try {
      await Share.share({
        title: place.name,
        message: `${place.name}\n${url}`,
        url,
      });
    } catch {
      // User cancelled share
    }
  };

  return (
    <>
      <View style={styles.container}>
        <ActionButton
          icon={<MaterialIcons name="directions" size={20} color="#fff" />}
          label={t("place.directions")}
          filled
          onPress={handleDirections}
        />
        <ActionButton
          icon={
            <MaterialIcons
              name={isSaved ? "bookmark" : "bookmark-border"}
              size={20}
              color={isSaved ? "#fff" : TEAL}
            />
          }
          label={isSaved ? t("place.savedPlace") : t("place.savePlace")}
          filled={isSaved}
          onPress={() => setSaveDialogOpen(true)}
        />
        {place.phone ? (
          <ActionButton
            icon={<MaterialIcons name="phone" size={20} color={TEAL} />}
            label={t("common.call", { defaultValue: "Call" })}
            onPress={handleCall}
          />
        ) : null}
        {place.website ? (
          <ActionButton
            icon={<MaterialIcons name="language" size={20} color={TEAL} />}
            label={t("common.website", { defaultValue: "Website" })}
            onPress={handleWebsite}
          />
        ) : null}
        <ActionButton
          icon={<MaterialIcons name="share" size={20} color={TEAL} />}
          label={t("place.share")}
          onPress={handleShare}
        />
      </View>
      <SavePlaceDialog
        visible={saveDialogOpen}
        onDismiss={() => setSaveDialogOpen(false)}
        place={place}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingVertical: 8,
  },
  actionButtonContainer: {
    alignItems: "center",
    gap: 6,
    minWidth: 56,
  },
  actionButtonCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonLabel: {
    fontSize: 12,
    fontWeight: "500",
    textAlign: "center",
  },
});

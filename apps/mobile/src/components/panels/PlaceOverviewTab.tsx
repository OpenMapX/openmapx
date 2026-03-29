import { MaterialIcons } from "@expo/vector-icons";
import type { Place } from "@openmapx/core";
import { computePlusCode, parseOpeningHours, plusCodeUrl, shortenPlusCode } from "@openmapx/core";
import * as ExpoClipboard from "expo-clipboard";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { ActivityIndicator, Divider, Text, useTheme } from "react-native-paper";
import { PlaceActionButtons } from "./PlaceActionButtons";

const TEAL = "#007b8b";

interface Props {
  place: Place;
  isLoading: boolean;
  onNavigateToInfo: () => void;
}

interface DetailRowProps {
  icon: string;
  children: React.ReactNode;
  copyValue?: string;
  onPress?: () => void;
}

function DetailRow({ icon, children, copyValue, onPress }: DetailRowProps) {
  const theme = useTheme();

  const handleLongPress = () => {
    if (copyValue) {
      ExpoClipboard.setStringAsync(copyValue);
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={handleLongPress}
      disabled={!onPress && !copyValue}
      style={({ pressed }) => [
        styles.detailRow,
        pressed && { backgroundColor: theme.colors.surfaceVariant },
      ]}
    >
      <MaterialIcons name={icon as keyof typeof MaterialIcons.glyphMap} size={22} color={TEAL} />
      <View style={styles.detailContent}>{children}</View>
    </Pressable>
  );
}

export function PlaceOverviewTab({ place, isLoading, onNavigateToInfo }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [hoursExpanded, setHoursExpanded] = useState(false);

  const hours = parseOpeningHours(place.openingHours, {
    lat: place.coordinates[1],
    lon: place.coordinates[0],
    countryCode: place.countryCode,
  });

  const plusCode = computePlusCode(place.coordinates);
  const shortCode = shortenPlusCode(plusCode);
  const city = place.city ?? null;
  const shortCodeDisplay = city ? `${shortCode} ${city}` : null;

  return (
    <View style={styles.container}>
      {/* Action buttons */}
      <PlaceActionButtons place={place} />

      {/* Description */}
      {place.description && (
        <>
          <Divider style={styles.divider} />
          <Pressable
            onPress={onNavigateToInfo}
            style={({ pressed }) => [
              styles.descriptionRow,
              pressed && { backgroundColor: theme.colors.surfaceVariant },
            ]}
          >
            <Text style={styles.descriptionText} numberOfLines={2}>
              {place.description}
            </Text>
            <MaterialIcons name="chevron-right" size={20} color={theme.colors.onSurfaceDisabled} />
          </Pressable>
        </>
      )}

      <Divider style={styles.divider} />

      {/* Address */}
      {place.address && (
        <DetailRow icon="place" copyValue={place.address}>
          <Text style={styles.detailText}>{place.address}</Text>
        </DetailRow>
      )}

      {/* Plus Code */}
      <DetailRow
        icon="apps"
        copyValue={shortCodeDisplay ?? plusCode}
        onPress={() => Linking.openURL(plusCodeUrl(plusCode))}
      >
        <Text style={styles.detailText}>{shortCodeDisplay ?? plusCode}</Text>
        {shortCodeDisplay && (
          <Text style={[styles.detailSubtext, { color: theme.colors.onSurfaceVariant }]}>
            {plusCode}
          </Text>
        )}
      </DetailRow>

      {/* Opening hours */}
      {isLoading && !place.openingHours ? (
        <DetailRow icon="access-time">
          <ActivityIndicator size="small" />
        </DetailRow>
      ) : (
        hours && (
          <Pressable
            onPress={hours.weekSchedule ? () => setHoursExpanded((v) => !v) : undefined}
            style={styles.detailRow}
          >
            <MaterialIcons name="access-time" size={22} color={TEAL} style={{ marginTop: 2 }} />
            <View style={styles.detailContent}>
              <View style={styles.hoursStatusRow}>
                <View style={styles.hoursStatusText}>
                  <Text
                    style={[styles.hoursStatus, { color: hours.isOpen ? "#4caf50" : "#e53935" }]}
                  >
                    {hours.isOpen ? t("common.open") : t("common.closed")}
                  </Text>
                  {hours.detail && (
                    <Text style={[styles.hoursDetail, { color: theme.colors.onSurfaceVariant }]}>
                      {" \u00B7 "}
                      {hours.detail}
                    </Text>
                  )}
                </View>
                {hours.weekSchedule && (
                  <MaterialIcons
                    name={hoursExpanded ? "expand-less" : "expand-more"}
                    size={18}
                    color={theme.colors.onSurfaceVariant}
                  />
                )}
              </View>
              {hoursExpanded && hours.weekSchedule && (
                <View style={styles.weekSchedule}>
                  {hours.weekSchedule.map(({ day, hours: h, isToday }) => (
                    <View key={day} style={styles.weekRow}>
                      <Text
                        style={[
                          styles.weekDay,
                          isToday && styles.weekDayToday,
                          !isToday && {
                            color: theme.colors.onSurfaceVariant,
                          },
                        ]}
                      >
                        {day}
                      </Text>
                      <Text
                        style={[
                          styles.weekHours,
                          isToday && styles.weekDayToday,
                          !isToday && {
                            color: theme.colors.onSurfaceVariant,
                          },
                        ]}
                      >
                        {h}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </Pressable>
        )
      )}

      {/* Phone */}
      {isLoading && !place.phone ? (
        <DetailRow icon="phone">
          <ActivityIndicator size="small" />
        </DetailRow>
      ) : (
        place.phone && (
          <DetailRow
            icon="phone"
            copyValue={place.phone}
            onPress={() => Linking.openURL(`tel:${place.phone}`)}
          >
            <Text style={[styles.detailText, { color: TEAL }]}>{place.phone}</Text>
          </DetailRow>
        )
      )}

      {/* Website */}
      {isLoading && !place.website ? (
        <DetailRow icon="language">
          <ActivityIndicator size="small" />
        </DetailRow>
      ) : (
        place.website && (
          <DetailRow
            icon="language"
            copyValue={place.website}
            onPress={() => {
              if (place.website) Linking.openURL(place.website);
            }}
          >
            <Text style={[styles.detailText, { color: TEAL }]} numberOfLines={1}>
              {place.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            </Text>
          </DetailRow>
        )
      )}

      {/* Wikipedia */}
      {place.wikipediaUrl && (
        <DetailRow
          icon="article"
          onPress={() => {
            if (place.wikipediaUrl) Linking.openURL(place.wikipediaUrl);
          }}
        >
          <Text style={[styles.detailText, { color: TEAL }]}>{t("place.wikipedia")}</Text>
        </DetailRow>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  divider: {
    marginVertical: 8,
  },
  descriptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 8,
  },
  descriptionText: {
    flex: 1,
    fontSize: 14,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingVertical: 10,
  },
  detailContent: {
    flex: 1,
    minWidth: 0,
  },
  detailText: {
    fontSize: 14,
  },
  detailSubtext: {
    fontSize: 12,
    marginTop: 2,
  },
  hoursStatusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  hoursStatusText: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  hoursStatus: {
    fontSize: 14,
    fontWeight: "500",
  },
  hoursDetail: {
    fontSize: 14,
  },
  weekSchedule: {
    marginTop: 8,
    marginBottom: 4,
  },
  weekRow: {
    flexDirection: "row",
    gap: 16,
    paddingVertical: 3,
  },
  weekDay: {
    width: 96,
    fontSize: 14,
  },
  weekDayToday: {
    fontWeight: "600",
  },
  weekHours: {
    fontSize: 14,
  },
});

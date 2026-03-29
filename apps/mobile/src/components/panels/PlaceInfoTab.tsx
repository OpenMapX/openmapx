import { MaterialIcons } from "@expo/vector-icons";
import type { Place } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Divider, Text, useTheme } from "react-native-paper";

interface Props {
  place: Place;
  isLoading: boolean;
}

interface TagGroup {
  labelKey: string;
  keys: readonly string[];
}

const ENRICHMENT_KEYS = new Set(["wikidata", "wikipedia", "wikimedia_commons"]);

const TAG_GROUPS: TagGroup[] = [
  {
    labelKey: "accessibility",
    keys: ["wheelchair", "wheelchair:description", "tactile_paving", "kerb"],
  },
  {
    labelKey: "serviceOptions",
    keys: [
      "takeaway",
      "delivery",
      "drive_through",
      "outdoor_seating",
      "indoor_seating",
      "dog",
      "smoking",
    ],
  },
  {
    labelKey: "paymentMethods",
    keys: [
      "payment:cash",
      "payment:credit_cards",
      "payment:debit_cards",
      "payment:contactless",
      "payment:coins",
      "payment:notes",
      "payment:visa",
      "payment:mastercard",
    ],
  },
  {
    labelKey: "foodAndDrink",
    keys: ["cuisine", "diet:vegan", "diet:vegetarian", "diet:halal", "diet:kosher"],
  },
  {
    labelKey: "internet",
    keys: ["internet_access", "internet_access:fee", "wifi"],
  },
  {
    labelKey: "recycling",
    keys: [
      "recycling:batteries",
      "recycling:cans",
      "recycling:glass",
      "recycling:paper",
      "recycling:plastic",
      "recycling:light_bulbs",
    ],
  },
];

function formatTagKey(key: string): string {
  return key
    .replace(/^[^:]+:/, (prefix) => `${prefix.slice(0, -1).replace(/_/g, " ")} \u00B7 `)
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function TagItem({ tagKey, value }: { tagKey: string; value: string }) {
  const theme = useTheme();
  const label = formatTagKey(tagKey);
  const isYes = value === "yes";
  const isNo = value === "no";

  return (
    <View style={styles.tagItem}>
      {isYes ? (
        <MaterialIcons name="check" size={16} color="#4caf50" />
      ) : isNo ? (
        <MaterialIcons name="close" size={16} color={theme.colors.onSurfaceDisabled} />
      ) : (
        <MaterialIcons name="check" size={16} color={theme.colors.onSurfaceDisabled} />
      )}
      <Text style={[styles.tagText, isNo && { color: theme.colors.onSurfaceDisabled }]}>
        {label}
        {!isYes && !isNo && (
          <Text style={{ color: theme.colors.onSurfaceVariant }}>
            {" \u00B7 "}
            {value}
          </Text>
        )}
      </Text>
    </View>
  );
}

interface RenderedGroup {
  labelKey: string;
  entries: Array<{ key: string; value: string }>;
}

function buildGroups(osmTags: Record<string, string>): RenderedGroup[] {
  const assigned = new Set<string>();
  const groups: RenderedGroup[] = [];

  for (const group of TAG_GROUPS) {
    const entries: Array<{ key: string; value: string }> = [];
    for (const key of group.keys) {
      const value = osmTags[key];
      if (value !== undefined) {
        entries.push({ key, value });
        assigned.add(key);
      }
    }
    if (entries.length > 0) {
      groups.push({ labelKey: group.labelKey, entries });
    }
  }

  const other: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(osmTags)) {
    if (!assigned.has(key) && !ENRICHMENT_KEYS.has(key)) {
      other.push({ key, value });
    }
  }
  if (other.length > 0) {
    groups.push({ labelKey: "otherDetails", entries: other });
  }

  return groups;
}

export function PlaceInfoTab({ place, isLoading }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const hasDescription = Boolean(place.description);
  const hasFacts = Boolean(place.facts?.length);
  const hasOsmTags = Boolean(place.osmTags && Object.keys(place.osmTags).length > 0);
  const hasAnyContent = hasDescription || hasFacts || hasOsmTags;

  if (isLoading && !hasAnyContent) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  if (!hasAnyContent) {
    return (
      <View style={styles.emptyContainer}>
        <MaterialIcons name="info-outline" size={40} color={theme.colors.onSurfaceDisabled} />
        <Text style={[styles.emptyTitle, { color: theme.colors.onSurfaceVariant }]}>
          {t("place.noAdditionalInfo")}
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.onSurfaceVariant }]}>
          {t("place.noOsmAttributes")}
        </Text>
      </View>
    );
  }

  const osmGroups = hasOsmTags ? buildGroups(place.osmTags as Record<string, string>) : [];
  const showDividerBeforeOsm = hasDescription || hasFacts;

  return (
    <View style={styles.container}>
      {/* Description */}
      {hasDescription && (
        <View style={styles.section}>
          <Text style={[styles.descriptionText, { color: theme.colors.onSurfaceVariant }]}>
            {place.description}
          </Text>
        </View>
      )}

      {/* Wikidata facts */}
      {hasFacts && (
        <>
          {hasDescription && <Divider />}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("place.aboutThisPlace")}</Text>
            <View style={styles.factsGrid}>
              {place.facts?.map(({ label, value }) => (
                <View key={label} style={styles.factItem}>
                  <Text style={[styles.factLabel, { color: theme.colors.onSurfaceVariant }]}>
                    {label}
                  </Text>
                  <Text style={styles.factValue}>{value}</Text>
                </View>
              ))}
            </View>
          </View>
        </>
      )}

      {/* OSM attribute groups */}
      {osmGroups.map((group, idx) => (
        <View key={group.labelKey}>
          {(idx === 0 ? showDividerBeforeOsm : true) && <Divider />}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t(`place.${group.labelKey}`)}</Text>
            <View style={styles.tagGrid}>
              {group.entries.map(({ key, value }) => (
                <TagItem key={key} tagKey={key} value={value} />
              ))}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: 16,
  },
  loadingContainer: {
    padding: 32,
    alignItems: "center",
  },
  emptyContainer: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  emptySubtitle: {
    fontSize: 12,
    textAlign: "center",
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  factsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  factItem: {
    width: "48%",
    marginBottom: 4,
  },
  factLabel: {
    fontSize: 12,
  },
  factValue: {
    fontSize: 14,
  },
  tagGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  tagItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    width: "48%",
    marginBottom: 4,
  },
  tagText: {
    fontSize: 14,
    flex: 1,
  },
});

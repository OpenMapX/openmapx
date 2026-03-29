import type { DataSourceFilterDef } from "@openmapx/core";
import { useDataSourceStore, useDataSources } from "@openmapx/core";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Text } from "react-native-paper";

const TEAL = "#007b8b";

function ChipFilterSection({
  filterDef,
  currentValue,
  onToggle,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
}) {
  const selected = (currentValue as (string | number)[] | undefined) ?? [];
  const [expanded, setExpanded] = useState(false);

  if (!filterDef.options || filterDef.options.length === 0) return null;

  const visibleOptions = expanded ? filterDef.options : filterDef.options.slice(0, 8);

  return (
    <View style={styles.section}>
      <Text variant="labelMedium" style={styles.sectionLabel}>
        {filterDef.label}
      </Text>
      <View style={styles.chipRow}>
        {visibleOptions.map((opt) => {
          const isActive = selected.includes(opt.id);
          return (
            <Chip
              key={String(opt.id)}
              selected={isActive}
              onPress={() => onToggle(filterDef.id, opt.id)}
              mode={isActive ? "flat" : "outlined"}
              selectedColor={isActive ? "#fff" : undefined}
              compact
              style={[styles.filterChip, isActive && styles.filterChipActive]}
              textStyle={[styles.filterChipText, isActive && styles.filterChipTextActive]}
            >
              {opt.label}
            </Chip>
          );
        })}
      </View>
      {filterDef.options.length > 8 && (
        <Pressable onPress={() => setExpanded(!expanded)}>
          <Text style={styles.showMoreText}>
            {expanded ? "Show less" : `Show all (${filterDef.options.length})`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function DataSourceFilterContent() {
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const setFilter = useDataSourceStore((s) => s.setFilter);
  const { data: sourcesData } = useDataSources();

  const sourceMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  const handleToggleMultiSelect = useCallback(
    (filterId: string, optionId: string | number) => {
      const current = (filters[filterId] as (string | number)[] | undefined) ?? [];
      const idx = current.indexOf(optionId);
      if (idx >= 0) {
        setFilter(
          filterId,
          current.filter((v) => v !== optionId),
        );
      } else {
        setFilter(filterId, [...current, optionId]);
      }
    },
    [filters, setFilter],
  );

  if (!sourceMeta) return null;

  return (
    <View style={styles.container}>
      <Text variant="titleMedium" style={styles.title}>
        {sourceMeta.name}
      </Text>
      {sourceMeta.filters.map((filterDef) => (
        <ChipFilterSection
          key={filterDef.id}
          filterDef={filterDef}
          currentValue={filters[filterDef.id]}
          onToggle={handleToggleMultiSelect}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: {
    fontWeight: "600",
    marginBottom: 12,
  },
  section: {
    marginBottom: 12,
  },
  sectionLabel: {
    color: "#666",
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  filterChip: {
    borderRadius: 18,
  },
  filterChipActive: {
    backgroundColor: TEAL,
  },
  filterChipText: {
    fontSize: 12,
  },
  filterChipTextActive: {
    color: "#fff",
  },
  showMoreText: {
    color: TEAL,
    fontSize: 13,
    fontWeight: "500",
    marginTop: 6,
  },
});

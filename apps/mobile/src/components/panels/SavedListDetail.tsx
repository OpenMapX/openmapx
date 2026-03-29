import { MaterialIcons } from "@expo/vector-icons";
import type { SavedPlace } from "@openmapx/core";
import {
  useDeleteList,
  usePlaceStore,
  useSavedListPlaces,
  useSavedLists,
  useSavedPlacesStore,
  useUpdateList,
  useUpdatePlace,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Dialog,
  Divider,
  IconButton,
  Menu,
  Portal,
  Text,
  useTheme,
} from "react-native-paper";
import { resolveListIcon } from "@/lib/listIcon";
import { useMap } from "@/lib/MapContext";
import { PlaceThumbnail } from "./PlaceThumbnail";

const TEAL = "#007b8b";
const TEAL_LIGHT = "#e0f2f4";

interface Props {
  listId: string;
}

export function SavedListDetail({ listId }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { flyTo } = useMap();

  const resolveListName = useCallback(
    (name: string) => (name.startsWith("$") ? t(`saved.${name.slice(1)}`) : name),
    [t],
  );

  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);

  const { data: lists } = useSavedLists();
  const { data: places, isLoading: placesLoading } = useSavedListPlaces(listId);

  const updateListMutation = useUpdateList();
  const deleteListMutation = useDeleteList();
  const updatePlaceMutation = useUpdatePlace();

  const list = lists?.find((l) => l.id === listId);

  const [menuVisible, setMenuVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteValue, setNoteValue] = useState("");

  const NAME_MAX = 40;

  const handleNameFocus = useCallback(() => {
    if (list) {
      setNameValue(resolveListName(list.name));
      setEditingName(true);
    }
  }, [list, resolveListName]);

  const handleNameBlur = useCallback(() => {
    if (!listId || !list) return;
    const trimmed = nameValue.trim();
    const currentDisplay = resolveListName(list.name);
    if (trimmed && trimmed !== currentDisplay) {
      updateListMutation.mutate({ id: listId, name: trimmed });
    }
    setEditingName(false);
  }, [listId, list, nameValue, updateListMutation, resolveListName]);

  const handleDeleteStart = useCallback(() => {
    setMenuVisible(false);
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    setConfirmDelete(false);
    deleteListMutation.mutate(listId, {
      onSuccess: () => {
        clearSelectedList();
        if (router.canGoBack()) {
          router.back();
        }
      },
    });
  }, [listId, deleteListMutation, clearSelectedList, router]);

  const handlePlaceClick = useCallback(
    (place: SavedPlace) => {
      setSelectedPlace({
        id: place.placeId ?? `saved:${place.id}`,
        name: place.name,
        address: place.address ?? "",
        coordinates: [place.lng, place.lat],
      });
      flyTo([place.lng, place.lat], 15);
      router.push(`/place/${encodeURIComponent(place.placeId ?? `saved:${place.id}`)}`);
    },
    [setSelectedPlace, flyTo, router],
  );

  const handleAddNote = useCallback((place: SavedPlace) => {
    setNoteEditId(place.id);
    setNoteValue(place.note ?? "");
  }, []);

  const handleNoteSubmit = useCallback(() => {
    if (!noteEditId) return;
    const trimmed = noteValue.trim();
    updatePlaceMutation.mutate(
      { id: noteEditId, note: trimmed || null },
      { onSuccess: () => setNoteEditId(null) },
    );
  }, [noteEditId, noteValue, updatePlaceMutation]);

  if (!list) {
    return null;
  }

  const isDefault = list.name.startsWith("$");

  return (
    <View>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.iconContainer}>{resolveListIcon(list.icon, 28)}</View>
          <View style={styles.headerContent}>
            {isDefault ? (
              <Text variant="titleLarge" style={styles.titleText}>
                {resolveListName(list.name)}
              </Text>
            ) : editingName ? (
              <TextInput
                style={styles.nameInput}
                value={nameValue}
                onChangeText={(text) => {
                  if (text.length <= NAME_MAX) setNameValue(text);
                }}
                onBlur={handleNameBlur}
                autoFocus
                maxLength={NAME_MAX}
              />
            ) : (
              <Pressable onPress={handleNameFocus}>
                <Text variant="titleLarge" style={styles.titleText}>
                  {resolveListName(list.name)}
                </Text>
              </Pressable>
            )}
          </View>
          <Menu
            visible={menuVisible}
            onDismiss={() => setMenuVisible(false)}
            anchor={
              <IconButton
                icon={({ size, color }) => (
                  <MaterialIcons name="more-vert" size={size} color={color} />
                )}
                size={20}
                onPress={() => setMenuVisible(true)}
              />
            }
          >
            <Menu.Item
              leadingIcon={({ size, color }) => (
                <MaterialIcons name="delete" size={size} color={color} />
              )}
              title={t("saved.deleteList")}
              onPress={handleDeleteStart}
            />
          </Menu>
        </View>

        <View style={styles.metaRow}>
          {list.isPrivate && (
            <MaterialIcons name="lock" size={14} color={theme.colors.onSurfaceVariant} />
          )}
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {list.isPrivate ? t("saved.private") : t("saved.shared")}
            {" \u00b7 "}
            {t("saved.places", { count: list.placeCount })}
          </Text>
        </View>

        <View style={styles.actionRow}>
          <Button
            mode="contained"
            icon={({ size, color }) => <MaterialIcons name="share" size={size - 2} color={color} />}
            style={styles.actionButton}
            labelStyle={styles.actionLabel}
            buttonColor={TEAL_LIGHT}
            textColor={TEAL}
            compact
          >
            {t("saved.share")}
          </Button>
          <Button
            mode="contained"
            icon={({ size, color }) => <MaterialIcons name="add" size={size - 2} color={color} />}
            style={styles.actionButton}
            labelStyle={styles.actionLabel}
            buttonColor={TEAL_LIGHT}
            textColor={TEAL}
            compact
          >
            {t("saved.addPlace")}
          </Button>
        </View>
      </View>

      <Divider />

      {/* Places list */}
      {placesLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={TEAL} />
        </View>
      ) : !places || places.length === 0 ? (
        <Text
          variant="bodyMedium"
          style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}
        >
          {t("saved.places", { count: 0 })}
        </Text>
      ) : (
        <View>
          {places.map((place) => (
            <Pressable
              key={place.id}
              onPress={() => handlePlaceClick(place)}
              style={({ pressed }) => [
                styles.placeRow,
                pressed && { backgroundColor: theme.colors.surfaceVariant },
              ]}
            >
              <PlaceThumbnail
                lat={place.lat}
                lng={place.lng}
                name={place.name}
                placeId={place.placeId}
              />
              <View style={styles.placeContent}>
                <Text variant="bodyMedium" style={styles.placeName} numberOfLines={1}>
                  {place.name}
                </Text>
                {place.address && (
                  <Text
                    variant="bodySmall"
                    style={{ color: theme.colors.onSurfaceVariant }}
                    numberOfLines={1}
                  >
                    {place.address}
                  </Text>
                )}
                {noteEditId === place.id ? (
                  <TextInput
                    style={[styles.noteInput, { borderColor: theme.colors.outline }]}
                    placeholder={t("saved.note")}
                    value={noteValue}
                    onChangeText={setNoteValue}
                    onBlur={handleNoteSubmit}
                    onSubmitEditing={handleNoteSubmit}
                    autoFocus
                  />
                ) : place.note ? (
                  <Pressable onPress={() => handleAddNote(place)}>
                    <Text variant="bodySmall" style={{ color: TEAL, marginTop: 2 }}>
                      {place.note}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {noteEditId !== place.id && !place.note && (
                <Pressable onPress={() => handleAddNote(place)} hitSlop={8}>
                  <Text variant="bodySmall" style={{ color: TEAL }}>
                    + {t("saved.note")}
                  </Text>
                </Pressable>
              )}
            </Pressable>
          ))}
        </View>
      )}

      <Portal>
        <Dialog visible={confirmDelete} onDismiss={() => setConfirmDelete(false)}>
          <Dialog.Title>{t("saved.delete")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("saved.deleteListConfirm")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmDelete(false)}>{t("common.cancel")}</Button>
            <Button textColor={theme.colors.error} onPress={handleDeleteConfirm}>
              {t("saved.delete")}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  headerContent: {
    flex: 1,
    minWidth: 0,
  },
  titleText: {
    fontWeight: "600",
    paddingVertical: 4,
  },
  nameInput: {
    fontSize: 20,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: "#f5f5f5",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  actionButton: {
    borderRadius: 24,
  },
  actionLabel: {
    fontWeight: "500",
    fontSize: 13,
  },
  loadingContainer: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    textAlign: "center",
    paddingVertical: 32,
  },
  placeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  placeContent: {
    flex: 1,
    minWidth: 0,
  },
  placeName: {
    fontWeight: "500",
  },
  noteInput: {
    marginTop: 4,
    fontSize: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 4,
  },
});

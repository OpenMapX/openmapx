import { MaterialIcons } from "@expo/vector-icons";
import type { Place, SavedPlace } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  useCreateList,
  useIsSaved,
  useRemovePlace,
  useSavedLists,
  useSavePlace,
} from "@openmapx/core";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Checkbox,
  Dialog,
  Portal,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import { resolveListIcon } from "@/lib/listIcon";

const TEAL = "#007b8b";
const TEAL_LIGHT = "#e0f2f4";

interface Props {
  visible: boolean;
  onDismiss: () => void;
  place: Place;
}

export function SavePlaceDialog({ visible, onDismiss, place }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();

  const resolveListName = (name: string) =>
    name.startsWith("$") ? t(`saved.${name.slice(1)}`) : name;

  const { data: lists, isLoading: listsLoading } = useSavedLists();
  const { data: savedInListIds } = useIsSaved(visible ? place.id : null);

  const savePlaceMutation = useSavePlace();
  const removePlaceMutation = useRemovePlace();
  const createListMutation = useCreateList();

  const [checkedLists, setCheckedLists] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (savedInListIds) {
      setCheckedLists(new Set(savedInListIds));
    }
  }, [savedInListIds]);

  const handleToggle = useCallback(
    async (listId: string) => {
      const isCurrentlyChecked = checkedLists.has(listId);

      if (isCurrentlyChecked) {
        setCheckedLists((prev) => {
          const next = new Set(prev);
          next.delete(listId);
          return next;
        });

        try {
          const res = await apiClient.get<{ places: SavedPlace[] }>(
            `${API_ENDPOINTS.savedLists}/${listId}/places`,
          );
          const match = res.places.find((p) => p.placeId === place.id);
          if (match) {
            removePlaceMutation.mutate(match.id);
          }
        } catch {
          setCheckedLists((prev) => new Set([...prev, listId]));
        }
      } else {
        setCheckedLists((prev) => new Set([...prev, listId]));
        savePlaceMutation.mutate({
          listId,
          name: place.name,
          address: place.address || null,
          lat: place.coordinates[1],
          lng: place.coordinates[0],
          placeId: place.id,
        });
      }
    },
    [checkedLists, place, savePlaceMutation, removePlaceMutation],
  );

  const handleCreateStart = useCallback(() => {
    setCreating(true);
    setNewName("");
  }, []);

  const handleCreateSubmit = useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setCreating(false);
      return;
    }
    createListMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (newList) => {
          setCreating(false);
          savePlaceMutation.mutate({
            listId: newList.id,
            name: place.name,
            address: place.address || null,
            lat: place.coordinates[1],
            lng: place.coordinates[0],
            placeId: place.id,
          });
          setCheckedLists((prev) => new Set([...prev, newList.id]));
        },
      },
    );
  }, [newName, createListMutation, savePlaceMutation, place]);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={styles.dialog}>
        <Dialog.Title style={styles.title}>{t("saved.saveTo")}</Dialog.Title>
        <Dialog.Content>
          {listsLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={TEAL} />
            </View>
          ) : (
            <>
              {lists?.map((list) => (
                <Pressable
                  key={list.id}
                  onPress={() => handleToggle(list.id)}
                  style={({ pressed }) => [
                    styles.listRow,
                    pressed && { backgroundColor: theme.colors.surfaceVariant },
                  ]}
                >
                  <Checkbox
                    status={checkedLists.has(list.id) ? "checked" : "unchecked"}
                    color={TEAL}
                  />
                  {resolveListIcon(list.icon)}
                  <Text variant="bodyMedium" style={styles.listName}>
                    {resolveListName(list.name)}
                  </Text>
                </Pressable>
              ))}

              {creating ? (
                <TextInput
                  mode="outlined"
                  dense
                  placeholder={t("saved.enterListName")}
                  value={newName}
                  onChangeText={setNewName}
                  onBlur={handleCreateSubmit}
                  onSubmitEditing={handleCreateSubmit}
                  autoFocus
                  style={styles.newListInput}
                />
              ) : (
                <Button
                  mode="contained"
                  icon={({ size, color }) => <MaterialIcons name="add" size={size} color={color} />}
                  onPress={handleCreateStart}
                  style={styles.createButton}
                  buttonColor={TEAL_LIGHT}
                  textColor={TEAL}
                >
                  {t("saved.createNewList")}
                </Button>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  dialog: {
    borderRadius: 12,
  },
  title: {
    fontWeight: "600",
  },
  loadingContainer: {
    padding: 24,
    alignItems: "center",
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    borderRadius: 8,
  },
  listName: {
    fontWeight: "500",
  },
  newListInput: {
    marginTop: 12,
  },
  createButton: {
    marginTop: 12,
    borderRadius: 24,
  },
});

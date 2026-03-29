import { MaterialIcons } from "@expo/vector-icons";
import type { SavedList } from "@openmapx/core";
import { useCreateList, useDeleteList, useSavedLists, useSavedPlacesStore } from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Dialog,
  IconButton,
  Menu,
  Portal,
  Text,
  useTheme,
} from "react-native-paper";
import { resolveListIcon } from "@/lib/listIcon";

const TEAL = "#007b8b";
const TEAL_LIGHT = "#e0f2f4";

export function SavedListsTab() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const resolveListName = (name: string) =>
    name.startsWith("$") ? t(`saved.${name.slice(1)}`) : name;

  const { data: lists, isLoading } = useSavedLists();
  const selectList = useSavedPlacesStore((s) => s.selectList);

  const createListMutation = useCreateList();
  const deleteListMutation = useDeleteList();

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuList, setMenuList] = useState<SavedList | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedList | null>(null);

  const handleCreate = useCallback(() => {
    createListMutation.mutate(
      { name: t("saved.untitledList") },
      {
        onSuccess: (created) => {
          selectList(created.id);
          router.push(`/saved/${created.id}`);
        },
      },
    );
  }, [createListMutation, t, selectList, router]);

  const handleMenuOpen = useCallback((list: SavedList) => {
    setMenuList(list);
    setMenuVisible(true);
  }, []);

  const handleMenuClose = useCallback(() => {
    setMenuVisible(false);
    setMenuList(null);
  }, []);

  const handleDeleteStart = useCallback(() => {
    const target = menuList;
    handleMenuClose();
    if (!target) return;
    setDeleteTarget(target);
  }, [menuList, handleMenuClose]);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    deleteListMutation.mutate(deleteTarget.id);
    setDeleteTarget(null);
  }, [deleteTarget, deleteListMutation]);

  const handleListPress = useCallback(
    (list: SavedList) => {
      selectList(list.id);
      router.push(`/saved/${list.id}`);
    },
    [selectList, router],
  );

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={TEAL} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Button
        mode="contained"
        icon={({ size, color }) => <MaterialIcons name="add" size={size} color={color} />}
        onPress={handleCreate}
        loading={createListMutation.isPending}
        disabled={createListMutation.isPending}
        style={styles.newListButton}
        labelStyle={styles.newListLabel}
        buttonColor={TEAL_LIGHT}
        textColor={TEAL}
      >
        {t("saved.newList")}
      </Button>

      {lists?.map((list) => (
        <Pressable
          key={list.id}
          onPress={() => handleListPress(list)}
          style={({ pressed }) => [
            styles.listRow,
            pressed && { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          <View style={styles.listIcon}>{resolveListIcon(list.icon)}</View>

          <View style={styles.listContent}>
            <Text variant="bodyMedium" style={styles.listName} numberOfLines={1}>
              {resolveListName(list.name)}
            </Text>
            <View style={styles.listMeta}>
              {list.isPrivate && (
                <MaterialIcons name="lock" size={14} color={theme.colors.onSurfaceVariant} />
              )}
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {list.isPrivate ? t("saved.private") : t("saved.shared")}
                {" \u00b7 "}
                {t("saved.places", { count: list.placeCount })}
              </Text>
            </View>
          </View>

          <Menu
            visible={menuVisible && menuList?.id === list.id}
            onDismiss={handleMenuClose}
            anchor={
              <IconButton
                icon={({ size, color }) => (
                  <MaterialIcons name="more-vert" size={size} color={color} />
                )}
                size={20}
                onPress={() => handleMenuOpen(list)}
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
        </Pressable>
      ))}

      <Portal>
        <Dialog visible={deleteTarget !== null} onDismiss={() => setDeleteTarget(null)}>
          <Dialog.Title>{t("saved.delete")}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{t("saved.deleteListConfirm")}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteTarget(null)}>{t("common.cancel")}</Button>
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
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  loadingContainer: {
    padding: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  newListButton: {
    borderRadius: 24,
    marginBottom: 12,
  },
  newListLabel: {
    fontWeight: "500",
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  listIcon: {
    alignItems: "center",
    justifyContent: "center",
  },
  listContent: {
    flex: 1,
    minWidth: 0,
  },
  listName: {
    fontWeight: "500",
  },
  listMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
});

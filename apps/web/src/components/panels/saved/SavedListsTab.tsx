"use client";

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import type { SavedList } from "@openmapx/core";
import { useCreateList, useDeleteList, useSavedLists, useSavedPlacesStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type React from "react";
import { useState } from "react";
import { resolveListIcon } from "@/lib/listIcon";
import { BRAND, BRAND_LIGHT } from "@/lib/theme";

export function SavedListsTab() {
  const t = useTranslations("saved");
  const tCommon = useTranslations("common");

  const resolveListName = (name: string) => (name.startsWith("$") ? t(name.slice(1)) : name);

  const { data: lists, isLoading } = useSavedLists();
  const selectList = useSavedPlacesStore((s) => s.selectList);

  const createListMutation = useCreateList();
  const deleteListMutation = useDeleteList();

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuList, setMenuList] = useState<SavedList | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedList | null>(null);

  const handleCreate = () => {
    createListMutation.mutate(
      { name: t("untitledList") },
      {
        onSuccess: (created) => {
          selectList(created.id);
        },
      },
    );
  };

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>, list: SavedList) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
    setMenuList(list);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
    setMenuList(null);
  };

  const handleDeleteStart = () => {
    setDeleteTarget(menuList);
    setDeleteDialogOpen(true);
    handleMenuClose();
  };

  const handleDeleteConfirm = () => {
    if (deleteTarget) {
      deleteListMutation.mutate(deleteTarget.id);
    }
    setDeleteDialogOpen(false);
    setDeleteTarget(null);
  };

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={28} sx={{ color: BRAND }} />
      </Box>
    );
  }

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Button
        fullWidth
        startIcon={<AddIcon />}
        onClick={handleCreate}
        disabled={createListMutation.isPending}
        sx={{
          borderRadius: 24,
          bgcolor: BRAND_LIGHT,
          color: BRAND,
          textTransform: "none",
          fontWeight: 500,
          mb: 1.5,
          "&:hover": { bgcolor: BRAND_LIGHT, filter: "brightness(0.95)" },
        }}
      >
        {t("newList")}
      </Button>
      {lists?.map((list) => (
        <Box
          key={list.id}
          onClick={() => selectList(list.id)}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            py: 1.5,
            px: 1,
            cursor: "pointer",
            borderRadius: 1,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {resolveListIcon(list.icon)}
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{
                fontWeight: 500,
              }}
            >
              {resolveListName(list.name)}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              {list.isPrivate && <LockIcon sx={{ fontSize: 14, color: "text.secondary" }} />}
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {list.isPrivate ? t("private") : t("shared")}
                {" \u00b7 "}
                {t("places", { count: list.placeCount })}
              </Typography>
            </Box>
          </Box>

          <IconButton size="small" onClick={(e) => handleMenuOpen(e, list)} sx={{ flexShrink: 0 }}>
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem onClick={handleDeleteStart}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("deleteList")}</ListItemText>
        </MenuItem>
      </Menu>
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>{t("delete")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("deleteListConfirm")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>{tCommon("cancel")}</Button>
          <Button onClick={handleDeleteConfirm} color="error" variant="contained">
            {t("delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

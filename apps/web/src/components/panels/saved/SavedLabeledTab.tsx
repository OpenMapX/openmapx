"use client";

import DeleteIcon from "@mui/icons-material/Delete";
import FlagIcon from "@mui/icons-material/Flag";
import HomeIcon from "@mui/icons-material/Home";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import WorkIcon from "@mui/icons-material/Work";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import type { LabeledPlace } from "@openmapx/core";
import {
  createPlace,
  idsFromPrimary,
  PANEL,
  useDeleteLabel,
  useLabeledPlaces,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";

interface PlaceholderLabel {
  key: "home" | "work";
  icon: React.ReactNode;
}

const PLACEHOLDER_LABELS: PlaceholderLabel[] = [
  { key: "home", icon: <HomeIcon sx={{ color: TEAL }} /> },
  { key: "work", icon: <WorkIcon sx={{ color: TEAL }} /> },
];

export function SavedLabeledTab() {
  const t = useTranslations("saved");
  const { data: labels, isLoading } = useLabeledPlaces();
  const deleteLabelMutation = useDeleteLabel();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { flyTo } = useMap();

  const handleLabelClick = (label: LabeledPlace) => {
    const identity = (label.placeId ? idsFromPrimary(label.placeId) : null) ?? {
      primaryScheme: "label",
      ids: { label: label.id },
    };
    setSelectedPlace(
      createPlace({
        ...identity,
        name: label.name,
        address: label.address ?? "",
        coordinates: [label.lng, label.lat],
      }),
    );
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    flyTo([label.lng, label.lat], 15);
  };

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuLabel, setMenuLabel] = useState<LabeledPlace | null>(null);

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>, label: LabeledPlace) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
    setMenuLabel(label);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
    setMenuLabel(null);
  };

  const handleRemove = () => {
    if (menuLabel) {
      deleteLabelMutation.mutate(menuLabel.label);
    }
    handleMenuClose();
  };

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={28} sx={{ color: TEAL }} />
      </Box>
    );
  }

  const homeLabel = labels?.find((l) => l.label.toLowerCase() === "home");
  const workLabel = labels?.find((l) => l.label.toLowerCase() === "work");
  const customLabels = labels?.filter(
    (l) => l.label.toLowerCase() !== "home" && l.label.toLowerCase() !== "work",
  );

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      {PLACEHOLDER_LABELS.map(({ key, icon }) => {
        const dbLabel = key === "home" ? homeLabel : workLabel;
        return (
          <Box
            key={key}
            onClick={dbLabel ? () => handleLabelClick(dbLabel) : undefined}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              py: 1.5,
              px: 1,
              borderRadius: 1,
              cursor: dbLabel ? "pointer" : "default",
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{icon}</Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 500,
                }}
              >
                {t(key)}
              </Typography>
              <Typography
                variant="caption"
                noWrap
                sx={{
                  color: "text.secondary",
                }}
              >
                {dbLabel?.address ?? t("notSet")}
              </Typography>
            </Box>
            {dbLabel && (
              <IconButton
                size="small"
                onClick={(e) => handleMenuOpen(e, dbLabel)}
                sx={{ flexShrink: 0 }}
              >
                <MoreVertIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        );
      })}
      {customLabels?.map((label) => (
        <Box
          key={label.id}
          onClick={() => handleLabelClick(label)}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            py: 1.5,
            px: 1,
            borderRadius: 1,
            cursor: "pointer",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <FlagIcon sx={{ color: TEAL }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
              }}
            >
              {label.label}
            </Typography>
            <Typography
              variant="caption"
              noWrap
              sx={{
                color: "text.secondary",
              }}
            >
              {label.address ?? t("notSet")}
            </Typography>
          </Box>
          <IconButton size="small" onClick={(e) => handleMenuOpen(e, label)} sx={{ flexShrink: 0 }}>
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
        <MenuItem onClick={handleRemove}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("removeAddress")}</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}

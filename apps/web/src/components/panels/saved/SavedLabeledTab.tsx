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
import {
  savedPlaceContributors,
  savedPlaceContributorsForPlace,
} from "@openmapx/core/saved-place-contributors";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ClickableRow } from "@/components/ui/ClickableRow";
import Menu from "@/components/ui/Menu";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";

interface PlaceholderLabel {
  key: "home" | "work";
  icon: React.ReactNode;
}

const PLACEHOLDER_LABELS: PlaceholderLabel[] = [
  { key: "home", icon: <HomeIcon sx={{ color: BRAND }} /> },
  { key: "work", icon: <WorkIcon sx={{ color: BRAND }} /> },
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
        ...savedPlaceContributorsForPlace(label.fieldContributors),
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
        <CircularProgress size={28} sx={{ color: BRAND }} />
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
      <AttributionDetailsGroup placement="footer" footerSx={{ px: 1 }}>
        {PLACEHOLDER_LABELS.map(({ key, icon }) => {
          const dbLabel = key === "home" ? homeLabel : workLabel;
          const content = (
            <>
              <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{icon}</Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {t(key)}
                </Typography>
                <Typography variant="caption" noWrap sx={{ color: "text.secondary" }}>
                  {dbLabel?.address ?? t("notSet")}
                </Typography>
              </Box>
            </>
          );
          return dbLabel ? (
            <LabelRow
              key={key}
              label={dbLabel}
              optionsLabel={t("itemOptions", { name: t(key) })}
              onOpen={handleLabelClick}
              onMenuOpen={handleMenuOpen}
            >
              {content}
            </LabelRow>
          ) : (
            <Box key={key} sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1.5, px: 1 }}>
              {content}
            </Box>
          );
        })}
        {customLabels?.map((label) => (
          <LabelRow
            key={label.id}
            label={label}
            optionsLabel={t("itemOptions", { name: label.label })}
            onOpen={handleLabelClick}
            onMenuOpen={handleMenuOpen}
          >
            <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              <FlagIcon sx={{ color: BRAND }} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {label.label}
              </Typography>
              <Typography variant="caption" noWrap sx={{ color: "text.secondary" }}>
                {label.address ?? t("notSet")}
              </Typography>
            </Box>
          </LabelRow>
        ))}
      </AttributionDetailsGroup>
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

/**
 * A saved label: the row opens the place, and its options button sits beside
 * the row so the two stay separate keyboard stops. The address credit stays
 * outside the button because it contains its own controls.
 */
function LabelRow({
  label,
  optionsLabel,
  onOpen,
  onMenuOpen,
  children,
}: {
  label: LabeledPlace;
  optionsLabel: string;
  onOpen: (label: LabeledPlace) => void;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, label: LabeledPlace) => void;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ borderRadius: 1, "&:hover": { bgcolor: "action.hover" } }}>
      <Box sx={{ display: "flex", alignItems: "center" }}>
        <ClickableRow onClick={() => onOpen(label)} sx={{ flex: 1, gap: 1.5, py: 1.5, px: 1 }}>
          {children}
        </ClickableRow>
        <IconButton
          size="small"
          aria-label={optionsLabel}
          onClick={(e) => onMenuOpen(e, label)}
          sx={{ flexShrink: 0 }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Box>
      {label.address && (
        <Box sx={{ pl: 5.5, pr: 1, pb: 1, mt: -1 }}>
          <AttributionStrip
            attributions={savedPlaceContributors(label.fieldContributors, ["address"])}
            variant="inline"
          />
        </Box>
      )}
    </Box>
  );
}

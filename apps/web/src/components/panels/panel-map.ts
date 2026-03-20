import type { SxProps, Theme } from "@mui/material/styles";
import type { ComponentType } from "react";
import { CategoryResultsContent } from "./category/CategoryResultsContent";
import { DataSourceFilterContent } from "./datasource/DataSourceFilterContent";
import { DirectionsPanelContent } from "./directions/DirectionsPanelContent";
import { PlaceDetailCard } from "./place/PlaceDetailCard";
import { PlacePanelContent } from "./place/PlacePanelContent";
import { SavedPlacesContent } from "./saved/SavedPlacesContent";

interface PanelEntry {
  component: ComponentType;
  contentSx?: SxProps<Theme>;
}

export const SIDEBAR_PANELS: Record<string, PanelEntry> = {
  place: { component: PlacePanelContent },
  category: { component: CategoryResultsContent },
  datasource: { component: DataSourceFilterContent },
  directions: { component: DirectionsPanelContent },
  saved: { component: SavedPlacesContent, contentSx: { pt: { xs: 0, sm: "72px" } } },
};

export const DETAIL_PANELS: Record<string, ComponentType> = {
  "place-card": PlaceDetailCard,
};
